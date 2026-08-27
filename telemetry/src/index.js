// Drop-in playback telemetry. Dependency-free; weeb-3 optional. See README.md.
//
// text/plain body = no CORS preflight (preflights get dropped on unload).
// fetch+keepalive over sendBeacon: sendBeacon is no-cors, which COEP pages block.

export const DEFAULTS = {
  endpoint: "",
  label: "", // collector supplies its own default when empty
  gw: "", // resolved to location.host — see resolveGateway()
  vid: "", // resolved from the page URL when omitted
  heartbeatMs: 30_000,
  // Polls media-time vs wall-clock instead of trusting `waiting`: hls.js hides
  // rebuffers by nudging currentTime, which looks like a seek.
  stallPollMs: 1000,
  stallRatio: 0.25, // below this share of expected progress = hanging; loose, so jitter doesn't count
  seekThresholdS: 2, // bigger media-time jumps are seeks, not watching
  node: null, // weeb-3 node; falls back to window.weeb3
  debug: false,
};

const MARKS = [25, 50, 75];

const perfNow = () => (globalThis.performance?.now ? performance.now() : Date.now());

function newSid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Defaults to the real host, so Swarm and localhost separate themselves.
function resolveGateway() {
  try {
    return location.host || "unknown";
  } catch {
    return "unknown";
  }
}

// From /watch/video/<owner>/<uuid> or ?v=. Reads the raw href, not
// URLSearchParams: a watch URL's "#" puts half the value in location.hash.
function resolveVid() {
  try {
    const href = location.href;
    const watch = /watch\/video\/(?:0x)?[0-9a-fA-F]{40}\/([0-9a-fA-F-]{16,})/.exec(href);
    if (watch) return watch[1];
    const param = /[?&](?:v|video|stream)=([^&]*)/.exec(href);
    if (param && param[1]) {
      let value = param[1];
      try {
        value = decodeURIComponent(value);
      } catch {
        /* keep raw */
      }
      const inner = /watch\/video\/(?:0x)?[0-9a-fA-F]{40}\/([0-9a-fA-F-]{16,})/.exec(value);
      return inner ? inner[1] : value.replace(/^\/+/, "");
    }
    return "";
  } catch {
    return "";
  }
}

// Fallback when the URL carries no id: the media file name, else the page path.
// MSE sources are blob: URLs, unique per session and useless as an id.
function resolveVidFromElement(el) {
  const src = el?.currentSrc || el?.src || "";
  if (src && !/^(blob|mediasource):/.test(src)) {
    try {
      const name = new URL(src, location.href).pathname.split("/").filter(Boolean).pop();
      if (name) return name.slice(0, 64);
    } catch {
      /* fall through to the path */
    }
  }
  try {
    return (location.pathname.replace(/^\/+|\/+$/g, "") || location.host || "").slice(0, 64);
  } catch {
    return "";
  }
}

function resolveLabel() {
  try {
    const m = /[?&]l=([^&]*)/.exec(location.href);
    return m && m[1] ? decodeURIComponent(m[1]) : "";
  } catch {
    return "";
  }
}

/**
 * Creates a reporter. Returns a handle; nothing is measured until attach().
 *
 * @param {Partial<typeof DEFAULTS>} options
 */
export function createTelemetry(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  // Never throw: telemetry must not break its host page.
  if (!cfg.endpoint) log(cfg, "no endpoint configured — reporting disabled");
  const sid = newSid();
  const attachedAt = perfNow();

  const base = {
    vid: String(cfg.vid || resolveVid()).slice(0, 64),
    label: cfg.label || resolveLabel(),
    gw: cfg.gw || resolveGateway(),
    sid,
  };

  const state = {
    watched: 0,
    depth: 0,
    seeks: 0,
    stalls: 0,
    stalledSec: 0,
    ttffSec: 0,
    started: false,
    completed: false,
    stopped: false,
    peers: 0,
    marks: new Set(),
  };

  let video = null;
  let hbTimer = null;
  let pollTimer = null;
  let pollAtTime = 0;
  let pollAtWall = 0;
  let inHang = false;
  let lastTime = 0;
  let observer = null;

  function post(body) {
    if (!cfg.endpoint) return;
    const json = JSON.stringify(body);
    log(cfg, "->", body.type, json.length + "b");
    try {
      return fetch(cfg.endpoint, {
        method: "POST",
        mode: "cors",
        keepalive: true,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: json,
      }).catch(() => {});
    } catch {
      try {
        navigator.sendBeacon?.(cfg.endpoint, new Blob([json], { type: "text/plain;charset=UTF-8" }));
      } catch {
        /* telemetry must never break playback */
      }
    }
  }

  const duration = () => (video && Number.isFinite(video.duration) ? video.duration : 0);

  function send(type, mark = 0) {
    post({
      type,
      ...base,
      watched: round(state.watched, 1),
      depth: round(state.depth, 3),
      dur: round(duration(), 1),
      seeks: state.seeks,
      mark,
      // Positional schema: keep this order, append only.
      stalls: state.stalls,
      stalled: round(state.stalledSec, 1),
      ttff: round(state.ttffSec, 2),
      peers: state.peers,
    });
  }

  // Optional node metrics. Sampled on an interval, not per-send: `end` can't await.
  let peerTimer = null;
  function startPeerSampling() {
    if (peerTimer || !(cfg.node || globalThis.weeb3)) return;
    peerTimer = setInterval(sampleNode, 5000);
  }
  function stopPeerSampling() {
    if (peerTimer) clearInterval(peerTimer);
    peerTimer = null;
  }

  async function sampleNode() {
    const node = cfg.node || globalThis.weeb3 || null;
    if (!node) return;
    try {
      if (typeof node.networkState === "function") {
        const ns = await node.networkState();
        for (const k of ["connections", "connected", "connectedPeers", "peers", "population"]) {
          if (typeof ns?.[k] === "number") {
            state.peers = ns[k];
            return;
          }
        }
      }
      if (typeof globalThis.wsCount === "function") state.peers = globalThis.wsCount();
    } catch {
      /* node metrics are best-effort */
    }
  }

  // ---- playback accounting ------------------------------------------------
  function onTimeUpdate() {
    const t = video.currentTime;
    const delta = t - lastTime;
    if (delta > 0 && delta < cfg.seekThresholdS) state.watched += delta;
    lastTime = t;

    const dur = duration();
    if (dur > 0) {
      state.depth = Math.max(state.depth, Math.min(t / dur, 1));
      const reached = state.depth * 100;
      for (const m of MARKS) {
        if (reached >= m && !state.marks.has(m)) {
          state.marks.add(m);
          send("progress", m);
        }
      }
      if (!state.completed && state.depth >= 0.98) {
        state.completed = true;
        send("complete");
      }
    }
  }

  function pollStall() {
    const now = perfNow();
    const t = video.currentTime;
    const elapsed = (now - pollAtWall) / 1000;
    const advanced = t - pollAtTime;
    pollAtWall = now;
    pollAtTime = t;
    if (!state.started || video.paused || video.ended || video.seeking || elapsed <= 0) {
      inHang = false;
      return;
    }
    // Deficit, not whole windows: a window straddling a hang contributes its
    // stalled part. Sub-150ms is jitter.
    const rate = video.playbackRate || 1;
    const deficit = elapsed - advanced / rate;
    if (deficit > 0.15) state.stalledSec += deficit;
    if (advanced < elapsed * cfg.stallRatio) {
      if (!inHang) {
        inHang = true;
        state.stalls += 1;
      }
    } else {
      inHang = false;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    pollAtWall = perfNow();
    pollAtTime = video.currentTime;
    inHang = false;
    pollTimer = setInterval(pollStall, cfg.stallPollMs);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    inHang = false;
  }

  function onPlaying() {
    if (!state.started) {
      state.started = true;
      if (!state.ttffSec) state.ttffSec = (perfNow() - attachedAt) / 1000;
      sampleNode();
      startPeerSampling();
      send("start");
      startPolling();
      if (!hbTimer) hbTimer = setInterval(heartbeat, cfg.heartbeatMs);
      return;
    }
    startPolling();
    if (!hbTimer) hbTimer = setInterval(heartbeat, cfg.heartbeatMs);
  }

  function heartbeat() {
    sampleNode(); // refreshes state.peers for the *next* row; never blocks this one
    send("heartbeat");
  }

  function onPause() {
    if (video.seeking || video.ended) return; // seek-scrub and ended aren't pauses
    stopPolling();
    stopHeartbeat();
    send("pause");
  }

  function onSeeked() {
    state.seeks += 1;
    lastTime = video.currentTime;
    // Re-baseline so the jump reads as neither progress nor a hang.
    pollAtTime = video.currentTime;
    pollAtWall = perfNow();
  }

  function onEnded() {
    stopPolling();
    if (!state.completed) {
      state.completed = true;
      send("complete");
    }
    stopHeartbeat();
  }

  function stopHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = null;
  }

  // Hidden tab flushes but keeps listening — viewers come back. Only
  // pagehide/stop() send `end`, keeping it one final row per pageview.
  function onVisibility() {
    if (document.visibilityState === "hidden") {
      stopHeartbeat();
      heartbeat();
    } else if (video && !video.paused && !state.stopped) {
      startPolling();
      if (!hbTimer) hbTimer = setInterval(heartbeat, cfg.heartbeatMs);
    }
  }

  const onPageHide = () => stop();

  const LISTENERS = [
    ["timeupdate", onTimeUpdate],
    ["playing", onPlaying],
    ["pause", onPause],
    ["seeked", onSeeked],
    ["ended", onEnded],
  ];

  /** Attach to a media element and start reporting. */
  function attach(el) {
    if (!el || video === el) return handle;
    if (video) detachListeners();
    video = el;
    if (!base.vid) base.vid = resolveVidFromElement(el);
    lastTime = video.currentTime || 0;
    for (const [ev, fn] of LISTENERS) video.addEventListener(ev, fn);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    sampleNode();
    send("view"); // funnel denominator: opened, may not press play
    log(cfg, "attached", base);
    return handle;
  }

  function detachListeners() {
    if (!video) return;
    for (const [ev, fn] of LISTENERS) video.removeEventListener(ev, fn);
  }

  /** Attach to a <video>, now or whenever one appears (players create them late). */
  function autoAttach() {
    const existing = document.querySelector("video");
    if (existing) {
      attach(existing);
      return handle;
    }
    if (observer || typeof MutationObserver === "undefined") return handle;
    observer = new MutationObserver(() => {
      const el = document.querySelector("video");
      if (el) {
        observer.disconnect();
        observer = null;
        attach(el);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    log(cfg, "waiting for a <video> element");
    return handle;
  }

  // silent: true detaches without a final row — for consent being withdrawn,
  // where one more beacon is the opposite of what was asked.
  function stop({ silent = false } = {}) {
    if (state.stopped) return;
    state.stopped = true;
    // Bank a hang in progress, else giving up mid-stall reports zero.
    if (video && pollTimer) pollStall();
    stopPolling();
    stopHeartbeat();
    stopPeerSampling();
    if (!silent) send("end");
    detachListeners();
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
    observer?.disconnect();
    observer = null;
  }

  const handle = { attach, autoAttach, stop, sid, config: cfg, state };
  return handle;
}

function round(v, places) {
  const f = 10 ** places;
  return Math.round((Number(v) || 0) * f) / f;
}

function log(cfg, ...args) {
  if (cfg.debug) console.log("[swarm-telemetry]", ...args);
}
