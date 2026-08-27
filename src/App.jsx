import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { useSwarmNode } from "./useSwarmNode.js";
import { parseWatchUrl, makeLiveResolver } from "./swarmFeed.js";
import { createLiveLoaders } from "./swarmHlsLive.js";
import { createTelemetry } from "swarm-stream-telemetry";

// One owner publishes all streams, so a bare uuid addresses one.
const STREAM_BASE =
  "https://streamoverswarm.eth.limo/#/watch/video/6F2728386F8a47ef5EBe323721188e630Ff0FdE9/";

const EXAMPLE_STREAM = STREAM_BASE + "0d216633-3475-4c26-8dd0-9935ef854bbc";

// ?v= / ?video= / ?stream=: full watch URL or bare uuid. Reads raw href, not
// URLSearchParams — a watch URL's "#" hides half the value in location.hash.
function streamFromLocation() {
  const m = /[?&](?:v|video|stream)=([^&]*)/.exec(location.href);
  if (!m || !m[1]) return null;
  let value = m[1].trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep the raw value if it isn't valid percent-encoding */
  }
  if (!value) return null;
  // Already a watch URL (however it arrived) — use it verbatim.
  if (/watch\/video\//.test(value)) return value;
  // Otherwise treat it as a video id under the known owner.
  return STREAM_BASE + value.replace(/^\/+/, "");
}

// Overridable at build time so a fork can point elsewhere.
const TELEMETRY_ENDPOINT =
  import.meta.env?.VITE_TELEMETRY_ENDPOINT ||
  "https://streaming-poc-collector.bekegerg.workers.dev/e";

// Internal phase: telemetry on for everyone, not switchable. Set to false to
// restore the public opt-in flow below — default off, user-controlled, sticky.
const TELEMETRY_ALWAYS_ON = true;

// Opt-in storage, used when TELEMETRY_ALWAYS_ON is false. Absent or unreadable
// storage means no consent — never assume yes.
const CONSENT_KEY = "swarm-telemetry-consent";
function readConsent() {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}
function writeConsent(on) {
  try {
    localStorage.setItem(CONSENT_KEY, on ? "1" : "0");
  } catch {
    /* private mode: the choice holds for this session only */
  }
}

const PHASE_LABEL = {
  booting: "Booting wasm runtime…",
  connecting: "Connecting to peers…",
  ready: "Ready",
  error: "Error",
};

// weeb-3's retrieveBytes returns the raw representation: an 8-byte span followed
// by the payload. Strip the span to get the file content.
const SPAN = 8;
async function retrieveContent(node, hex) {
  const raw = await node.retrieveBytes(hex);
  const u = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  return u.length >= SPAN ? u.subarray(SPAN) : u;
}

export default function App() {
  const { node, phase, connections, error } = useSwarmNode();

  // ---- stream playback (feed via SOC probing, segments via native retrieveBytes) ----
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const trackerRef = useRef(null);
  // Resolved before first render so the field shows what will play.
  const [urlParamStream] = useState(() => streamFromLocation());
  const [streamUrl, setStreamUrl] = useState(urlParamStream ?? EXAMPLE_STREAM);
  const [streamStatus, setStreamStatus] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [consent, setConsent] = useState(() => (TELEMETRY_ALWAYS_ON ? true : readConsent()));
  const [segLog, setSegLog] = useState([]);
  // Autoplay ?v= once the node is up. Ref-guarded so re-renders can't restart it.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!node || !urlParamStream || autoStartedRef.current) return;
    autoStartedRef.current = true;
    startStream(urlParamStream);
  }, [node]); // eslint-disable-line react-hooks/exhaustive-deps

  // Toggling mid-playback takes effect immediately: withdrawing stops without a
  // final beacon, granting starts measuring from that point (not retroactively).
  useEffect(() => {
    // Don't persist during the internal phase: leaves the stored preference
    // untouched for when the opt-in flow comes back.
    if (!TELEMETRY_ALWAYS_ON) writeConsent(consent);
    if (!consent) {
      trackerRef.current?.stop({ silent: true });
      trackerRef.current = null;
      return;
    }
    if (!trackerRef.current && videoRef.current && !videoRef.current.paused) {
      trackerRef.current = createTelemetry({
        endpoint: TELEMETRY_ENDPOINT,
        vid: parseWatchUrl(streamUrl)?.uuid || "",
        node,
      }).attach(videoRef.current);
    }
  }, [consent]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    trackerRef.current?.stop();
    hlsRef.current?.destroy();
  }, []);

  function handlePlay(e) {
    e.preventDefault();
    startStream(streamUrl);
  }

  async function startStream(url) {
    if (!node || !url || !url.trim()) return;
    const parsed = parseWatchUrl(url.trim());
    if (!parsed) {
      setStreamStatus("Not a recognizable /watch/video/<owner>/<uuid> URL.");
      return;
    }
    setStreaming(true);
    setSegLog([]);
    setStreamStatus("Resolving feed…");
    try {
      if (!Hls.isSupported()) {
        setStreamStatus("hls.js/MediaSource not supported in this browser.");
        return;
      }
      // Live-capable: the playlist loader re-resolves the feed on every hls.js
      // reload, so new segments of a live stream appear. Works for VOD too
      // (an #EXT-X-ENDLIST playlist just isn't reloaded).
      const getManifest = makeLiveResolver(parsed.owner, parsed.uuid, (h) => node.retrieveChunk(h), {
        onProbe: (i) => setStreamStatus(`Probing feed index ${i}…`),
      });
      const { PlaylistLoader, FragmentLoader } = createLiveLoaders(
        getManifest,
        (ref) => retrieveContent(node, ref), // native erasure-decoded segment bytes
        {
          onManifest: ({ index }) => setStreamStatus(`Live — feed index ${index}, served by the in-browser node.`),
          onSegment: (s) => setSegLog((l) => [`${s.hex.slice(0, 8)}… · ${(s.bytes / 1024).toFixed(0)} KB · ${s.ms} ms`, ...l].slice(0, 8)),
        }
      );
      hlsRef.current?.destroy();
      // One tracker per playback attempt; the previous one flushes its `end` row.
      trackerRef.current?.stop();
      if (consent) {
        trackerRef.current = createTelemetry({
          endpoint: TELEMETRY_ENDPOINT,
          vid: parsed.uuid,
          node, // lets it report peer count alongside playback
        }).attach(videoRef.current);
      }
      const hls = new Hls({
        pLoader: PlaylistLoader,
        fLoader: FragmentLoader,
        enableWorker: true,
        maxBufferLength: 20,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
      });
      hlsRef.current = hls;
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoRef.current?.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) setStreamStatus(`HLS error: ${data.details}`);
      });
      hls.loadSource("https://swarm.local/live.m3u8");
      hls.attachMedia(videoRef.current);
    } catch (err) {
      setStreamStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="app">
      <header>
        <h1>Swarm in-browser node — POC (weeb-3)</h1>
        <p className="sub">
          weeb-3 light node, bootstrapped on tab creation. Erasure-coded bytes are
          decoded <strong>natively</strong> by the node (<code>retrieveBytes</code>);
          streaming resolves the feed over p2p and plays each segment through the node.
        </p>
      </header>

      <section className="card">
        <div className="status-row">
          <span className={`badge badge-${phase}`}>{PHASE_LABEL[phase]}</span>
          <span className="metric">
            <strong>{connections}</strong> peer{connections === 1 ? "" : "s"} connected
          </span>
        </div>
        {error && <p className="err">Boot error: {error.message}</p>}
      </section>

      <section className="card">
        <h2>Watch a stream</h2>
        <p className="sub">
          Paste a stream link (<code>…/#/watch/video/&lt;owner&gt;/&lt;uuid&gt;</code>).
          The node resolves the sequential feed (SOC probing), then streams every
          segment through <code>retrieveBytes</code> (erasure-decoded natively).
        </p>
        <form onSubmit={handlePlay}>
          <label className="field">
            <span>Stream URL</span>
            <input type="text" value={streamUrl} onChange={(e) => setStreamUrl(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <button type="submit" disabled={!node || streaming}>{streaming ? "Resolving…" : "Play via node"}</button>
          {phase !== "ready" && <span className="hint">Node isn’t fully connected yet.</span>}
        </form>
        {streamStatus && <p className="baseline" style={{ marginTop: 14 }}>{streamStatus}</p>}
        <label className={`consent${TELEMETRY_ALWAYS_ON ? " consent-locked" : ""}`}>
          <input
            type="checkbox"
            checked={consent}
            disabled={TELEMETRY_ALWAYS_ON}
            onChange={(e) => setConsent(e.target.checked)}
          />
          <span>
            Playback stats — watch time, stalls, startup wait, peer count. No IP or
            personal data.{" "}
            {TELEMETRY_ALWAYS_ON
              ? "Always on during internal testing."
              : `${consent ? "On" : "Off"}; your choice is remembered.`}
          </span>
        </label>
        <video ref={videoRef} controls playsInline muted style={{ width: "100%", marginTop: 14, borderRadius: 8, background: "#000", aspectRatio: "16 / 9" }} />
        {segLog.length > 0 && (
          <>
            <h3>Segments served by the node</h3>
            <pre className="mono">{segLog.join("\n")}</pre>
          </>
        )}
      </section>
    </div>
  );
}
