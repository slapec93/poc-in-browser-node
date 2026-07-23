import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { useSwarmNode } from "./useSwarmNode.js";
import { joinBytes } from "./erasureJoiner.js";
import { parseWatchUrl, resolvePlaylist } from "./swarmFeed.js";
import { createSwarmStream } from "./swarmHlsLoader.js";

const EXAMPLE_STREAM =
  "https://streamoverswarm.eth.limo/#/watch/video/6F2728386F8a47ef5EBe323721188e630Ff0FdE9/0d216633-3475-4c26-8dd0-9935ef854bbc";

// -------------------------------------------------------------------------
// Predefined address to reconstruct from the network.
//
// A real, currently-live Swarm mainnet bytes reference: one ~1.8 MB MPEG-TS
// segment (`.ts`) from a beebridge stream. It is erasure-coded (Bee ≥2.8.1
// default), so weeb-3's built-in retrieveBytes returns 0 — we reconstruct it
// ourselves with the erasure-aware joiner over retrieveChunk.
// -------------------------------------------------------------------------
const DEFAULT_ADDRESS =
  "68d3d40b39d5f17532e928a4b62f2a58ea1b63e20da0eb4b8a7da78d45d45812";

const PHASE_LABEL = {
  booting: "Booting wasm runtime…",
  connecting: "Connecting to peers…",
  ready: "Ready",
  error: "Error",
};

function toHexPreview(bytes, max = 64) {
  const slice = bytes.subarray(0, max);
  let hex = "";
  for (const b of slice) hex += b.toString(16).padStart(2, "0");
  return hex + (bytes.length > max ? "…" : "");
}

function toTextPreview(bytes, max = 1024) {
  const slice = bytes.subarray(0, max);
  let printable = 0;
  for (const b of slice) {
    if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++;
  }
  if (printable / slice.length < 0.9) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(slice) + (bytes.length > max ? "\n…" : "");
}

function sniffType(bytes) {
  if (bytes.length === 0) return null;
  if (bytes[0] === 0x47) return "MPEG-TS video segment (.ts)";
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return "PNG image";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "JPEG image";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  if (bytes[0] === 0x23 && bytes[1] === 0x21) return "shell script / playlist";
  if (bytes[0] === 0x25 && bytes[1] === 0x50) return "PDF";
  return null;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

export default function App() {
  const { node, phase, connections, connecting, error } = useSwarmNode();

  const [address, setAddress] = useState(DEFAULT_ADDRESS);
  const [fetching, setFetching] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [fetchError, setFetchError] = useState(null);

  // ---- stream playback ----
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
    if (typeof window !== "undefined") window.__streamStats = { bytes: 0, segs: 0, reconstructed: 0, t0: 0 };
    setStreamStatus("Discovering feed index…");
    try {
      const { index, text, segments } = await resolvePlaylist(
        parsed.owner,
        parsed.uuid,
        (h) => node.retrieveChunk(h),
        { concurrency: 16, onProbe: (i) => setStreamStatus(`Probing feed index ${i}…`) }
      );
      setStreamStatus(`Playlist @ index ${index}: ${segments.length} segments. Starting player…`);

      if (!Hls.isSupported()) {
        setStreamStatus("hls.js/MediaSource not supported in this browser.");
        return;
      }
      hlsRef.current?.destroy();
      const { SwarmLoader } = createSwarmStream(segments, (h) => node.retrieveChunk(h), joinBytes, {
        segConcurrency: 2,
        chunkConcurrency: 12,
        lookahead: 6,
        onSegment: (s) => {
          if (typeof window !== "undefined") {
            const st = window.__streamStats;
            if (st) {
              if (!st.t0) st.t0 = performance.now();
              st.bytes += s.bytes;
              st.segs++;
            }
          }
          setSegLog((l) =>
            [`${s.hex.slice(0, 8)}… · ${(s.bytes / 1024).toFixed(0)} KB · ${s.ms} ms · ${s.chunks} chunks`, ...l].slice(0, 8)
          );
        },
      });
      const hls = new Hls({
        fLoader: SwarmLoader,
        enableWorker: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        backBufferLength: 30,
      });
      hlsRef.current = hls;
      const blobUrl = URL.createObjectURL(new Blob([text], { type: "application/vnd.apple.mpegurl" }));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setStreamStatus(`Playing — index ${index}, ${segments.length} segments, served by the in-browser node.`);
        videoRef.current?.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (data.fatal) setStreamStatus(`HLS error: ${data.details}`);
      });
      hls.loadSource(blobUrl);
      hls.attachMedia(videoRef.current);
    } catch (err) {
      setStreamStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setStreaming(false);
    }
  }

  async function handleFetch(e) {
    e.preventDefault();
    if (!node || !address.trim()) return;
    setFetching(true);
    setProgress(0);
    setResult(null);
    setFetchError(null);

    const addr = address.trim();
    const started = performance.now();
    try {
      // Reconstruct client-side: erasure-aware joiner over weeb-3's retrieveChunk.
      const { bytes, chunksFetched } = await joinBytes(
        addr,
        (hex) => node.retrieveChunk(hex),
        { concurrency: 12, onProgress: (n) => setProgress(n) }
      );
      const elapsedMs = performance.now() - started;
      const kbps = bytes.length / 1024 / (elapsedMs / 1000);
      setResult({
        length: bytes.length,
        chunksFetched,
        elapsedMs,
        kbps,
        type: sniffType(bytes),
        hex: toHexPreview(bytes),
        text: toTextPreview(bytes),
      });
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFetching(false);
    }
  }

  const canFetch = !!node && !fetching && address.trim().length > 0;

  return (
    <div className="app">
      <header>
        <h1>Swarm in-browser node — POC</h1>
        <p className="sub">
          weeb-3 light node, bootstrapped on tab creation. Reconstructs an
          erasure-coded bytes address <strong>client-side</strong> from raw
          chunks — no gateway, no network fix.
        </p>
      </header>

      <section className="card">
        <div className="status-row">
          <span className={`badge badge-${phase}`}>{PHASE_LABEL[phase]}</span>
          <span className="metric">
            <strong>{connections}</strong> peer{connections === 1 ? "" : "s"} connected
            {connecting > 0 && <span className="muted"> · {connecting} connecting</span>}
          </span>
        </div>
        {error && <p className="err">Boot error: {error.message}</p>}
      </section>

      <section className="card">
        <form onSubmit={handleFetch}>
          <label className="field">
            <span>Bytes address (hex root reference — may be erasure-coded)</span>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="64-hex bytes root reference"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <button type="submit" disabled={!canFetch}>
            {fetching ? `Reconstructing… (${progress} chunks)` : "Reconstruct bytes"}
          </button>
          {phase !== "ready" && (
            <span className="hint">Node isn’t fully connected yet — may be slow or fail.</span>
          )}
        </form>
      </section>

      {fetchError && (
        <section className="card">
          <p className="err">Reconstruction failed: {fetchError}</p>
        </section>
      )}

      {result && (
        <section className="card result">
          <h2>Result</h2>
          <div className="grid">
            <div>
              <span className="k">Size</span>
              <span className="v">{formatBytes(result.length)}</span>
            </div>
            <div>
              <span className="k">Chunks</span>
              <span className="v">{result.chunksFetched}</span>
            </div>
            <div>
              <span className="k">Time</span>
              <span className="v">{result.elapsedMs.toFixed(0)} ms</span>
            </div>
            <div>
              <span className="k">Throughput</span>
              <span className="v">{result.kbps.toFixed(1)} KB/s</span>
            </div>
          </div>
          <p className="baseline">
            {result.type ? `Detected: ${result.type}. ` : ""}
            Baseline (ultra-light Bee node): ~670 KB/s
          </p>

          <h3>Hex preview</h3>
          <pre className="mono">{result.hex}</pre>

          {result.text != null && (
            <>
              <h3>Text preview</h3>
              <pre className="mono">{result.text}</pre>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Watch a stream</h2>
        <p className="sub">
          Paste a stream link (<code>…/#/watch/video/&lt;owner&gt;/&lt;uuid&gt;</code>).
          The node resolves the SOC feed → HLS playlist → and streams every
          segment through the in-browser node (erasure-decoded on the fly).
        </p>
        <form onSubmit={handlePlay}>
          <label className="field">
            <span>Stream URL</span>
            <input
              type="text"
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <button type="submit" disabled={!node || streaming}>
            {streaming ? "Resolving…" : "Play via node"}
          </button>
          {phase !== "ready" && <span className="hint">Node isn’t fully connected yet.</span>}
        </form>

        {streamStatus && <p className="baseline" style={{ marginTop: 14 }}>{streamStatus}</p>}

        <video
          ref={videoRef}
          controls
          playsInline
          muted
          style={{ width: "100%", marginTop: 14, borderRadius: 8, background: "#000", aspectRatio: "16 / 9" }}
        />

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
