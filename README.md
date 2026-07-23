# Swarm in-browser node — POC (weeb-3)

DevCon video-stream-over-Swarm POC: a **React + Vite** app that **bootstraps a
weeb-3 light node on tab creation** and **reconstructs a predefined bytes address
directly from the Swarm network — fully in the browser, no gateway.**

The content on mainnet is **erasure-coded** (Bee ≥2.8.1 default), which the
built-in `retrieveBytes` can't parse. So the POC reconstructs it **client-side**
with an erasure-aware joiner built on weeb-3's working single-chunk primitive
(`retrieveChunk`). **No network fix and no Rust patch required.**

## Status: ✅ working

Verified end-to-end in real Google Chrome against live mainnet content:

```
Reconstruct 68d3d40b… (1.8 MB MPEG-TS segment, erasure-coded)
→ 447 chunks, 4.4 s, 401.5 KB/s, sha256 matches the gateway byte-for-byte
```

- ✅ **Bootstrap on tab creation** — connects to 100+ mainnet peers, flips to Ready.
- ✅ **Client-side retrieval of erasure-coded content** — reconstructs the exact
  file from raw chunks (throughput ~400 KB/s vs. the ~670 KB/s ultra-light Bee
  baseline).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

Wait for **Ready**, then hit **Reconstruct bytes** (pre-filled with a live
erasure-coded segment). The result panel reports size, chunk count, time,
throughput, and sniffs the file type. The node is exposed as `window.weeb3`
(e.g. `await weeb3.retrieveChunk("<hex>")`).

## How it works

| File | Role |
|---|---|
| `src/useSwarmNode.js` | Singleton boot (`init()` → `new Weeb3No103()` → `start()`), StrictMode-safe; polls `readyState(1,0)` for live peer counts. |
| `src/erasureJoiner.js` | **The key piece.** Erasure-aware joiner over `retrieveChunk`: `DecodeSpan` (mask the level flag), walk DATA refs, skip PARITY. |
| `src/App.jsx` | Status panel + reconstruct form with live chunk progress and throughput. |
| `vite.config.js` | wasm plugins + required **COOP/COEP** cross-origin-isolation headers. |

### The erasure-coding gotcha (root cause of the earlier 0-byte failures)

Bee encodes the redundancy level in the **top byte of a chunk's 8-byte span**
(`span[7] = level | 0x80`, see Bee `pkg/file/redundancy/span.go`). A naive joiner
reads that as a ~9-exabyte size and falls apart. The fix:

1. **`DecodeSpan`** — if `span[7] > 128`, mask the top byte to get the real size.
2. **Walk only DATA refs** — at each intermediate, children are `[data…, parity…]`;
   fetch data children until their spans cover the real size, skip the rest.
   No Reed-Solomon needed while the data chunks are retrievable (parity is only
   needed to reconstruct *missing* data chunks).

**Why it's a Bee 2.8.1 regression** (tracked in `ethersphere/bee#5541`): PR #5383
flipped the default **upload** redundancy from `NONE` → `MEDIUM`, so every
header-less upload since 2026‑07‑07 is erasure-coded. Older (plain) content still
reads fine; fresh content broke every erasure-blind client. It is **not** a
chequebook/SWAP issue and **not** primarily a peer-reachability issue.

## Requirements & gotchas

- **Cross-origin isolation is mandatory** — weeb-3 uses `SharedArrayBuffer` + wasm
  threads, so the page must send `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Dev + preview set these; prod must too.
- wasm payload ~4.35 MB.
- We use `retrieveChunk` (works), **not** `retrieveBytes` (erasure-blind, returns 0).
- ⚠️ Chose weeb-3 over hoverfly specifically because weeb-3 **exposes a single-chunk
  fetch** we can build the joiner on; hoverfly only exposes its erasure-blind
  bytes `fetch()`.

## ✅ Watch a stream (working)

Paste a stream link (`…/#/watch/video/<owner>/<uuid>`, e.g. from
`streamoverswarm.eth.limo` or `swarm.beebridge.buzz`) and it **plays via the
in-browser node** — verified end-to-end in real Chrome (video decodes and plays;
each segment fetched over p2p and erasure-decoded on the fly).

Flow (all through `retrieveChunk`, no gateway):

1. **Parse** the watch URL → `owner` + `uuid` (`src/swarmFeed.js`).
2. **topic** = `keccak256(uuid)`; **find the latest feed index** by probing SOC
   addresses `keccak256(keccak256(topic ‖ uint64_BE(i)) ‖ owner)` (exponential +
   binary search — ~12 s for a 646-update feed).
3. **Resolve the playlist**: `retrieveChunk(socAddr)` returns the SOC *already
   unwrapped* to the content root chunk → join it → HLS `#EXTM3U` text.
4. **Play**: hls.js with a custom fragment loader (`src/swarmHlsLoader.js`) that
   pulls each `.ts` segment through the erasure joiner and hands it to
   MediaSource.

Measured: ~2–3 s per 1.8 MB segment (~450 chunks each) — close to, but not yet
comfortably above, the 2 s-per-segment realtime budget, so expect occasional
rebuffering. See tuning below.

| File | Role |
|---|---|
| `src/swarmFeed.js` | Watch-URL parse, topic/identifier/SOC-address derivation, feed-index discovery, SOC→playlist resolution. |
| `src/swarmHlsLoader.js` | hls.js fragment loader that fetches segments via the node + joiner. |

## Next steps

1. **Throughput for smooth realtime**: prefetch segments in parallel, raise joiner
   concurrency, and enable the IndexedDB chunk store (`enableChunkStore`) so
   re-watches are instant.
2. Add **Reed-Solomon** decoding to the joiner for resilience when some data
   chunks are unreachable (currently relies on all data chunks being available).
3. Upstream `DecodeSpan` into weeb-3's/hoverfly's built-in joiner so
   `retrieveBytes`/`fetch` handle erasure coding directly.
