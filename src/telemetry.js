// Playback telemetry → the collector Worker (collector/src/index.js).
//
// Schema is positional on the Worker side; this module owns the client half:
//   type · vid · label · gw · sid          (strings)
//   watched · depth · dur · seeks · mark   (numbers)
//
// Transport notes, both load-bearing:
//
//  1. Content-Type is text/plain, NOT application/json. text/plain is
//     CORS-safelisted, so POST /e never triggers a preflight — which matters
//     because a preflight fired during page unload is routinely dropped. The
//     Worker ignores the header and JSON.parses the body regardless.
//  2. The page is cross-origin isolated (COEP: require-corp, needed for
//     weeb-3's SharedArrayBuffer). Under require-corp a *no-cors* response
//     without Cross-Origin-Resource-Policy is blocked, and sendBeacon sends
//     no-cors. So the primary path is fetch({mode:"cors", keepalive:true}),
//     whose CORS-ok response satisfies COEP; sendBeacon is only the fallback
//     (the Worker sends CORP: cross-origin so that path works too).

const ENDPOINT =
  import.meta.env?.VITE_TELEMETRY_ENDPOINT ||
  "https://streaming-poc-collector.bekegerg.workers.dev/e";

// Media-time jumps larger than this are treated as a seek, not as watching.
const SEEK_THRESHOLD_S = 2;
const HEARTBEAT_MS = 30_000;
const MARKS = [25, 50, 75];

function newSid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// The ?l= query param tags a distribution link; the Worker defaults it.
function labelFromLocation() {
  try {
    return new URLSearchParams(location.search).get("l") || "";
  } catch {
    return "";
  }
}

function post(body) {
  const json = JSON.stringify(body);
  try {
    // Simple request (text/plain) + CORS + keepalive: no preflight, survives unload.
    return fetch(ENDPOINT, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: json,
    }).catch(() => {});
  } catch {
    // Fallback for the unload edge where fetch is refused.
    try {
      navigator.sendBeacon?.(ENDPOINT, new Blob([json], { type: "text/plain;charset=UTF-8" }));
    } catch {
      /* telemetry must never break playback */
    }
  }
}

/**
 * Attaches playback telemetry to a <video>. Returns a handle; call stop() when
 * the player goes away (it emits the final `end` row).
 *
 * `watched` accumulates *content actually played* — positive currentTime deltas
 * below the seek threshold — so neither scrubbing nor a p2p stall inflates it.
 * `depth` is the furthest fraction reached. High depth + low watched = scrubbing.
 *
 * @param {HTMLVideoElement} video
 * @param {{vid: string, gw?: string, label?: string}} meta
 */
export function trackPlayback(video, meta) {
  const sid = newSid();
  const base = {
    vid: String(meta.vid || "").slice(0, 64),
    label: meta.label ?? labelFromLocation(),
    gw: meta.gw || "weeb-3-browser",
    sid,
  };

  let watched = 0;
  let depth = 0;
  let seeks = 0;
  let lastTime = video.currentTime || 0;
  let started = false;
  let completed = false;
  let stopped = false;
  const sentMarks = new Set();
  let hbTimer = null;

  const duration = () => (Number.isFinite(video.duration) ? video.duration : 0);

  function send(type, mark = 0) {
    const dur = duration();
    post({
      type,
      ...base,
      watched: Math.round(watched * 10) / 10,
      depth: Math.round(depth * 1000) / 1000,
      dur: Math.round(dur * 10) / 10,
      seeks,
      mark,
    });
  }

  function onTimeUpdate() {
    const t = video.currentTime;
    const delta = t - lastTime;
    // Only forward progress under the threshold counts as watching; a bigger
    // jump is a seek (counted in `seeks` by onSeeked) and contributes nothing.
    if (delta > 0 && delta < SEEK_THRESHOLD_S) watched += delta;
    lastTime = t;

    const dur = duration();
    if (dur > 0) {
      depth = Math.max(depth, Math.min(t / dur, 1));
      const pctReached = depth * 100;
      for (const m of MARKS) {
        if (pctReached >= m && !sentMarks.has(m)) {
          sentMarks.add(m);
          send("progress", m);
        }
      }
      if (!completed && depth >= 0.98) {
        completed = true;
        send("complete");
      }
    }
  }

  function onPlaying() {
    if (!started) {
      started = true;
      send("start");
    }
    if (!hbTimer) hbTimer = setInterval(() => send("heartbeat"), HEARTBEAT_MS);
  }

  function onPause() {
    if (video.seeking || video.ended) return; // seek-scrub and ended aren't pauses
    stopHeartbeat();
    send("pause");
  }

  function onSeeked() {
    seeks += 1;
    lastTime = video.currentTime;
  }

  function onEnded() {
    if (!completed) {
      completed = true;
      send("complete");
    }
    stopHeartbeat();
  }

  function stopHeartbeat() {
    if (hbTimer) {
      clearInterval(hbTimer);
      hbTimer = null;
    }
  }

  // `end` carries the final aggregates and must fire exactly once per pageview —
  // the dashboard reads watch behaviour from these rows only, so pagehide (the
  // reliable unload signal) and unmount are its only triggers.
  function onPageHide() {
    stop();
  }

  // Hiding the tab must NOT tear the tracker down — the viewer may well be
  // switching away and coming back (e.g. to check a dashboard). Flush the
  // aggregates as a heartbeat so nothing is lost if the tab is later killed
  // without a pagehide, but keep listening. Only pagehide/unmount send `end`,
  // which is what keeps it exactly one row per pageview.
  function onVisibility() {
    if (document.visibilityState === "hidden") {
      stopHeartbeat();
      send("heartbeat");
    } else if (!video.paused && !stopped) {
      if (!hbTimer) hbTimer = setInterval(() => send("heartbeat"), HEARTBEAT_MS);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    send("end");
    video.removeEventListener("timeupdate", onTimeUpdate);
    video.removeEventListener("playing", onPlaying);
    video.removeEventListener("pause", onPause);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("ended", onEnded);
    window.removeEventListener("pagehide", onPageHide);
    document.removeEventListener("visibilitychange", onVisibility);
  }

  video.addEventListener("timeupdate", onTimeUpdate);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("pause", onPause);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("ended", onEnded);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  send("view"); // the funnel's denominator: opened the stream, may not press play

  return { sid, stop };
}
