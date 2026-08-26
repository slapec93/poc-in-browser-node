/* ============================================================
   Streaming POC — collector + dashboard (one Cloudflare Worker)

     POST /e            beacons in, from the player
     GET  /stats?k=...  the numbers, rendered

   ---- Deploy ----
     npx wrangler secret put CF_ACCOUNT_ID     # dashboard URL: /<this>/workers
     npx wrangler secret put CF_API_TOKEN      # scope: Account Analytics · Read
     npx wrangler secret put STATS_TOKEN       # any long random string you invent
     npx wrangler deploy

   Then set CONFIG.endpoint in index.html to
     https://streaming-poc-collector.<subdomain>.workers.dev/e
   and bookmark
     https://streaming-poc-collector.<subdomain>.workers.dev/stats?k=<STATS_TOKEN>

   While testing, `npx wrangler tail` shows every beacon as it lands —
   that works before the secrets are set.

   ---- Schema (positional, do not reorder) ----
     blob1 type   blob2 vid   blob3 label   blob4 gateway   blob5 country   blob6 session
     double1 watched   double2 depth   double3 duration   double4 seeks   double5 mark
   ============================================================ */

const DATASET = "SwarmStreamingTelemetry";
const EVENTS = new Set(["view", "start", "progress", "pause", "heartbeat", "complete", "end"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (url.pathname === "/e" && request.method === "POST") return collect(request, env);
    if (url.pathname === "/stats") return stats(url, env);
    return new Response("not found", { status: 404, headers: cors() });
  }
};

/* ---------------- write path ---------------- */

async function collect(request, env) {
  let ev;
  try { ev = JSON.parse(await request.text()); }
  catch { return new Response("bad json", { status: 400, headers: cors() }); }
  if (!ev || !EVENTS.has(ev.type)) {
    return new Response("bad event", { status: 400, headers: cors() });
  }

  const cf = request.cf || {};
  const row = {
    // IP is deliberately not stored. Country is enough for a closed
    // distribution list and keeps this defensible without a consent banner.
    type: String(ev.type),
    vid: str(ev.vid, 64),
    label: str(ev.label, 40) || "(nincs)",
    gw: str(ev.gw, 80),
    country: String(cf.country || "??"),
    sid: str(ev.sid, 40),
    watched: num(ev.watched), depth: num(ev.depth), dur: num(ev.dur),
    seeks: num(ev.seeks), mark: num(ev.mark)
  };

  console.log(JSON.stringify(row));

  if (env.ANALYTICS_ENGINE) {
    env.ANALYTICS_ENGINE.writeDataPoint({
      blobs: [row.type, row.vid, row.label, row.gw, row.country, row.sid],
      doubles: [row.watched, row.depth, row.dur, row.seeks, row.mark],
      indexes: [row.vid]
    });
  }
  return new Response(null, { status: 204, headers: cors() });
}

const str = (v, n) => String(v == null ? "" : v).slice(0, n);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);

/* ---------------- read path ---------------- */

async function sql(env, query) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    { method: "POST", headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` }, body: query }
  );
  const text = await res.text();
  if (!res.ok) throw new Error(`Analytics Engine ${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text).data || []; }
  catch { throw new Error(`unparseable response: ${text.slice(0, 400)}`); }
}

async function stats(url, env) {
  const key = url.searchParams.get("k") || "";
  if (!env.STATS_TOKEN || !safeEqual(key, env.STATS_TOKEN)) {
    return new Response("nope", { status: 403 });
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return html(page("<p class=err>Set CF_ACCOUNT_ID and CF_API_TOKEN as Worker secrets first.</p>"), 500);
  }

  const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get("d") || "30", 10)));
  const since = `timestamp > NOW() - INTERVAL '${days}' DAY`;

  try {
    // Funnel. sumIf(_sample_interval, cond) is the sampling-correct way to
    // count rows; plain count() undercounts once ABR starts sampling.
    const [funnel] = await sql(env, `
      SELECT sumIf(_sample_interval, blob1='view')     AS opened,
             sumIf(_sample_interval, blob1='start')    AS started,
             sumIf(_sample_interval, blob1='progress' AND double5=25) AS m25,
             sumIf(_sample_interval, blob1='progress' AND double5=50) AS m50,
             sumIf(_sample_interval, blob1='progress' AND double5=75) AS m75,
             sumIf(_sample_interval, blob1='complete') AS m100,
             count(DISTINCT blob6)                     AS sessions
      FROM ${DATASET} WHERE ${since}`);

    // 'end' fires once per pageview and carries the final aggregates,
    // so it is the row to read watch behaviour from.
    const [watch] = await sql(env, `
      SELECT SUM(_sample_interval * double1) / SUM(_sample_interval) AS avg_watched,
             quantileExactWeighted(0.5)(double1, _sample_interval)   AS med_watched,
             quantileExactWeighted(0.5)(double2, _sample_interval)   AS med_depth,
             MAX(double3)                                            AS dur,
             SUM(_sample_interval)                                   AS n
      FROM ${DATASET} WHERE blob1='end' AND ${since}`);

    const labels = await sql(env, `
      SELECT blob3 AS label,
             count(DISTINCT blob6)                     AS sessions,
             sumIf(_sample_interval, blob1='start')    AS plays,
             sumIf(_sample_interval, blob1='complete') AS completes,
             avgIf(double1, blob1='end')               AS avg_watched,
             avgIf(double2, blob1='end')               AS avg_depth
      FROM ${DATASET} WHERE ${since}
      GROUP BY label ORDER BY sessions DESC LIMIT 50`);

    const gateways = await sql(env, `
      SELECT blob4 AS gw, count(DISTINCT blob6) AS sessions
      FROM ${DATASET} WHERE ${since} GROUP BY gw ORDER BY sessions DESC LIMIT 15`);

    const countries = await sql(env, `
      SELECT blob5 AS country, count(DISTINCT blob6) AS sessions
      FROM ${DATASET} WHERE ${since} GROUP BY country ORDER BY sessions DESC LIMIT 15`);

    const recent = await sql(env, `
      SELECT timestamp, blob1 AS type, blob3 AS label, blob5 AS country,
             double1 AS watched, double2 AS depth
      FROM ${DATASET} WHERE ${since} ORDER BY timestamp DESC LIMIT 25`);

    return html(page(render({ k: key, days, funnel, watch, labels, gateways, countries, recent })));
  } catch (e) {
    return html(page(`<p class=err>${esc(e.message)}</p>`), 500);
  }
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* ---------------- rendering ---------------- */

const esc = s => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n0 = v => Math.round(Number(v) || 0).toLocaleString("en-US");
const n1 = v => (Number(v) || 0).toFixed(1);
const pct = (a, b) => (!b ? "—" : Math.round((Number(a) / Number(b)) * 100) + "%");

function bar(value, max) {
  const w = !max ? 0 : Math.max(1, Math.round((Number(value) / Number(max)) * 100));
  return `<span class=bar><i style="width:${w}%"></i></span>`;
}

function render(d) {
  const f = d.funnel || {}, w = d.watch || {};
  const opened = Number(f.opened) || 0;
  const dur = Number(w.dur) || 0;

  const steps = [
    ["Opened", f.opened], ["Started", f.started],
    ["25%", f.m25], ["50%", f.m50], ["75%", f.m75], ["Completed", f.m100]
  ];

  return `
  <header class=head>
    <p class=eyebrow>Swarm · in-browser streaming · closed distribution</p>
    <h1 class=title>Streaming POC — Viewership</h1>
    <div class=rule></div>
    <p class=meta>Last ${d.days} days · ${n0(f.sessions)} sessions · updated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC</p>
  </header>

  <section>
    <h2>Funnel</h2>
    <table>
      ${steps.map(([k, v]) => `<tr>
        <th>${esc(k)}</th>
        <td class=num>${n0(v)}</td>
        <td class=num>${pct(v, opened)}</td>
        <td class=barcell>${bar(v, opened)}</td></tr>`).join("")}
    </table>
    <p class=note>Percentages are relative to opens. The gap between “started” and “opened” is people who clicked through but never hit play.</p>
  </section>

  <section>
    <h2>Watch behaviour</h2>
    <table>
      <tr><th>Average play time</th><td class=num>${n1(w.avg_watched)} s</td>
          <td class=num>${dur ? pct(w.avg_watched, dur) : "—"}</td></tr>
      <tr><th>Median play time</th><td class=num>${n1(w.med_watched)} s</td>
          <td class=num>${dur ? pct(w.med_watched, dur) : "—"}</td></tr>
      <tr><th>Median reach</th><td class=num>${Math.round((Number(w.med_depth) || 0) * 100)}%</td><td></td></tr>
      <tr><th>Closed sessions</th><td class=num>${n0(w.n)}</td><td></td></tr>
    </table>
    <p class=note>Play time = actual playback, in wall-clock seconds. Reach = the furthest point reached. High reach with short play time is scrubbing, not watching.</p>
  </section>

  <section>
    <h2>Links</h2>
    ${d.labels.length ? `<table>
      <tr class=hdr><th>Label</th><th class=num>Sessions</th><th class=num>Starts</th>
          <th class=num>Completed</th><th class=num>Avg. time</th><th class=num>Avg. reach</th></tr>
      ${d.labels.map(r => `<tr>
        <td>${esc(r.label)}</td>
        <td class=num>${n0(r.sessions)}</td>
        <td class=num>${n0(r.plays)}</td>
        <td class=num>${n0(r.completes)}</td>
        <td class=num>${n1(r.avg_watched)} s</td>
        <td class=num>${Math.round((Number(r.avg_depth) || 0) * 100)}%</td></tr>`).join("")}
    </table>` : `<p class=note>No data yet.</p>`}
  </section>

  <div class=cols>
    <section>
      <h2>Gateways</h2>
      <table>${d.gateways.map(r => `<tr><td>${esc(r.gw)}</td><td class=num>${n0(r.sessions)}</td></tr>`).join("") || "<tr><td class=note>—</td></tr>"}</table>
      <p class=note>The gateway they actually reached it through.</p>
    </section>
    <section>
      <h2>Countries</h2>
      <table>${d.countries.map(r => `<tr><td>${esc(r.country)}</td><td class=num>${n0(r.sessions)}</td></tr>`).join("") || "<tr><td class=note>—</td></tr>"}</table>
    </section>
  </div>

  <section>
    <h2>Recent events</h2>
    <table class=small>
      ${d.recent.map(r => `<tr>
        <td>${esc(String(r.timestamp).slice(0, 19).replace("T", " "))}</td>
        <td>${esc(r.type)}</td><td>${esc(r.label)}</td><td>${esc(r.country)}</td>
        <td class=num>${n1(r.watched)} s</td>
        <td class=num>${Math.round((Number(r.depth) || 0) * 100)}%</td></tr>`).join("")
      || "<tr><td class=note>—</td></tr>"}
    </table>
    <p class=note>Raw rows, for debugging. Analytics Engine is not long-term storage — export regularly if you need an archive.</p>
  </section>

  <p class=foot>This counts our own player only. Anyone fetching the video hash directly, or opening it through another gateway in their own player, does not appear here. A lower bound, not a headcount.</p>
  <p class=foot>Range: ${[7, 30, 90].map(n =>
    `<a href="?k=${encodeURIComponent(d.k)}&amp;d=${n}">${n} days</a>`).join(" · ")}</p>`;
}

function page(body) {
  return `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<meta name=robots content="noindex,nofollow"><title>Streaming POC — Viewership</title>
<style>
:root{color-scheme:dark;
--bg:#0d1216;--card:#1f2831;--line:#2d3843;
--ink:#f6f7f9;--ink2:#b2b6b8;--muted:#8b909a;
--accent:#fe6e00;--track:rgba(254,110,0,.16);
--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
*{box-sizing:border-box}
body{margin:0;padding:clamp(20px,4vw,48px);background:var(--bg);color:var(--ink);
font-family:var(--sans);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
main{max-width:820px;margin:0 auto}
.eyebrow{font-size:10px;font-weight:600;text-transform:uppercase;
letter-spacing:.18em;color:var(--muted);margin:0 0 10px}
.title{font-size:clamp(24px,5vw,32px);font-weight:650;letter-spacing:-.01em;line-height:1.05;margin:0}
.rule{height:3px;width:52px;background:var(--accent);border-radius:2px;margin:14px 0 12px}
.meta{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:var(--muted);margin:0}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:18px 20px 20px;margin:16px 0}
h2{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.14em;
color:var(--accent);margin:0 0 12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse}
td,th{padding:7px 8px;text-align:left;font-weight:400;vertical-align:baseline;
border-bottom:1px solid rgba(45,56,67,.5)}
tr:last-child td,tr:last-child th{border-bottom:0}
th{font-size:13px;color:var(--ink)}
.hdr th{font-size:9.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--muted)}
.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.barcell{width:32%}
.bar{display:block;height:10px;background:var(--track);border-radius:0 5px 5px 0}
.bar i{display:block;height:100%;background:var(--accent);border-radius:0 4px 4px 0}
.small td{font-size:12.5px;color:var(--ink2)}
.note{font-size:11.5px;color:var(--muted);margin:10px 0 0;line-height:1.6}
.foot{font-size:11.5px;color:var(--muted);margin:18px 0 0;padding-top:12px;
border-top:1px solid var(--line);line-height:1.65}
.err{background:rgba(254,110,0,.08);border:1px solid var(--line);border-left:3px solid var(--accent);
border-radius:8px;color:var(--ink);padding:14px;font-size:13px;word-break:break-word}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
@media(max-width:560px){.cols{grid-template-columns:1fr}.barcell{display:none}}
a{color:var(--accent);text-decoration:none;border-bottom:1px solid rgba(254,110,0,.45)}
a:hover{border-bottom-color:var(--accent)}
code{font-family:var(--mono);font-size:12px}
</style></head><body><main>${body}</main></body></html>`;
}

const html = (body, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400"
  };
}
