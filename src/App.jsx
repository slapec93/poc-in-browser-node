import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { useSwarmNode } from "./useSwarmNode.js";
import { parseWatchUrl, makeLiveResolver } from "./swarmFeed.js";
import { createLiveLoaders } from "./swarmHlsLive.js";

const EXAMPLE_STREAM =
  "https://streamoverswarm.eth.limo/#/watch/video/6F2728386F8a47ef5EBe323721188e630Ff0FdE9/0d216633-3475-4c26-8dd0-9935ef854bbc";

// A real, currently-live Swarm mainnet bytes reference: one ~1.8 MB MPEG-TS
// segment. weeb-3 0.0.32x decodes its erasure coding natively in retrieveBytes.
const DEFAULT_ADDRESS =
  "68d3d40b39d5f17532e928a4b62f2a58ea1b63e20da0eb4b8a7da78d45d45812";

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

function toHexPreview(bytes, max = 64) {
  let hex = "";
  for (const b of bytes.subarray(0, max)) hex += b.toString(16).padStart(2, "0");
  return hex + (bytes.length > max ? "…" : "");
}
function sniffType(b) {
  if (!b.length) return null;
  if (b[0] === 0x47) return "MPEG-TS video segment (.ts)";
  if (b[0] === 0x89 && b[1] === 0x50) return "PNG image";
  if (b[0] === 0xff && b[1] === 0xd8) return "JPEG image";
  if (b[0] === 0x23 && b[1] === 0x21) return "shell script / playlist";
  return null;
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export default function App() {
  const { node, phase, connections, error } = useSwarmNode();

  // ---- reconstruct a single bytes address ----
  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [fetching, setFetching] = useState(false);
  const [result, setResult] = useState(null);
  const [fetchError, setFetchError] = useState(null);

  async function handleFetch(e) {
    e.preventDefault();
    if (!node || !address.trim()) return;
    setFetching(true);
    setResult(null);
    setFetchError(null);
    const started = performance.now();
    try {
      const bytes = await retrieveContent(node, address.trim()); // native erasure decode
      if (!bytes || bytes.length === 0) throw new Error("empty result (0 bytes)");
      const elapsedMs = performance.now() - started;
      setResult({
        length: bytes.length,
        elapsedMs,
        kbps: bytes.length / 1024 / (elapsedMs / 1000),
        type: sniffType(bytes),
        hex: toHexPreview(bytes),
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }
  const canFetch = !!node && !fetching && address.trim().length > 0;

  // ---- stream playback (feed via SOC probing, segments via native retrieveBytes) ----
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [streamUrl, setStreamUrl] = useState(EXAMPLE_STREAM);
  const [streamStatus, setStreamStatus] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [segLog, setSegLog] = useState([]);
  useEffect(() => () => hlsRef.current?.destroy(), []);

  async function handlePlay(e) {
    e.preventDefault();
    if (!node || !streamUrl.trim()) return;
    const parsed = parseWatchUrl(streamUrl.trim());
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
        <form onSubmit={handleFetch}>
          <label className="field">
            <span>Bytes address (hex root reference — may be erasure-coded)</span>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} spellCheck={false} autoComplete="off" />
          </label>
          <button type="submit" disabled={!canFetch}>{fetching ? "Retrieving…" : "Retrieve bytes"}</button>
          {phase !== "ready" && <span className="hint">Node isn’t fully connected yet — may be slow or fail.</span>}
        </form>
      </section>

      {fetchError && (
        <section className="card"><p className="err">Retrieval failed: {fetchError}</p></section>
      )}

      {result && (
        <section className="card result">
          <h2>Result</h2>
          <div className="grid">
            <div><span className="k">Size</span><span className="v">{formatBytes(result.length)}</span></div>
            <div><span className="k">Time</span><span className="v">{result.elapsedMs.toFixed(0)} ms</span></div>
            <div><span className="k">Throughput</span><span className="v">{result.kbps.toFixed(1)} KB/s</span></div>
          </div>
          <p className="baseline">{result.type ? `Detected: ${result.type}.` : ""}</p>
          <h3>Hex preview</h3>
          <pre className="mono">{result.hex}</pre>
        </section>
      )}

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
