# Swarm in-browser node — POC (weeb-3)

DevCon video-stream-over-Swarm POC: a **React + Vite** app that **bootstraps a
weeb-3 light node on tab creation**, **retrieves an erasure-coded bytes address**,
and **plays an HLS stream** — all directly from the Swarm network in the browser,
no gateway.

Built on **`@lat-murmeldjur/weeb_3` 0.0.324001**, which added native erasure
decoding since the earlier 0.0.320001 pin.

## Status: ✅ working (hybrid)

Verified end-to-end in real Google Chrome against live mainnet content:

```
Retrieve 68d3d40b… (1.8 MB erasure-coded MPEG-TS segment) → decodes natively
Play stream …/0d216633… → feed resolved (index 646), 646 segments, video plays
```

- ✅ **Bootstrap on tab creation** — `new Weeb3No103()` → `start()`; readiness via
  `ready(min, timeout)`.
- ✅ **Native erasure retrieval** — `retrieveBytes(addr)` decodes erasure coding in
  the node (no client-side joiner needed).
- ✅ **Streaming** — sequential-feed resolution + HLS playback via the node.

### Throughput — honest numbers

Do **not** read the single-segment retrieve as throughput. The pre-filled demo
segment is over-requested (fetched constantly during development), so in
isolation it comes back fast — that is a best case, not the norm.

Real cold streaming is what matters, and it's **slow**: measured per ~1.85 MB
segment during actual playback: **1.9, 2.5, 2.9, 3.2, 3.4, 4.0, 4.2, 7.3 s** —
i.e. **~2–7 s/segment, ~3 s typical (~580 KB/s)**, and highly variable. That's
seconds per 2 s of video, so a high-bitrate stream (stream A ≈ 1.4 MB/s) still
rebuffers; only a low-bitrate stream keeps up. Native `retrieveBytes` is faster
and simpler than the old client-side joiner, but it does **not** remove the
browser-light-node throughput ceiling — that's a peer/forwarder-reach limit.

## The hybrid — what's native vs. what we still do client-side

weeb-3 0.0.32x ships native erasure decoding, feeds, and an `attachStream()` HLS
player. We adopted the parts that drop cleanly into a custom React UI and kept
our own code where weeb-3's assumptions didn't fit:

| Concern | Approach | Why |
|---|---|---|
| **Bytes retrieval + segments** | ✅ native `retrieveBytes()` | Decodes erasure natively (no client-side joiner). Faster and simpler than the old joiner, but still seconds/segment cold — see **Throughput**. Returns `span(8) ‖ data`, so we strip 8 bytes for the file content. |
| **Feed → playlist** | 🔧 our SOC-probing (`retrieveChunk`) | weeb-3's native `acquireFeedBytes()` resolves a *different* feed convention and returns "not found" for beebridge's bee-js **sequential** feeds (verified — the feeds are alive and resolve fine by probing the SOC addresses directly). |
| **Playlist bytes** | 🔧 erasure joiner (`joinFromChunk`) | A long VOD playlist is ~80 KB (multi-chunk, erasure-coded). The SOC gives the content *chunk*, not an address, so `retrieveBytes` can't take it — we join the small playlist tree. |
| **HLS player** | 🔧 hls.js custom loader | weeb-3's native `attachStream()` requires its **service-worker "forwarder"** deployed under a hardcoded `/weeb-3/` path (it registers `/weeb-3/service.js`, scope `/weeb-3/`). That assumes the app *is* weeb-3's own deployment; it doesn't embed at an arbitrary path. We keep a thin hls.js loader that pulls each segment via `retrieveBytes` — no service worker. |

Net effect vs. the old (0.0.320001) POC: the **erasure joiner is no longer on the
retrieval hot path** (segments + the reconstruct feature are native); it survives
only to decode the tiny playlist tree. This simplifies the code and helps
per-segment time, but the overall throughput ceiling still stands — see
**Throughput**.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
```

Wait for **Ready**, then **Retrieve bytes** (pre-filled with a live erasure-coded
segment) or **Play via node** (a live stream). The node is `window.weeb3`.

## How it works

| File | Role |
|---|---|
| `src/useSwarmNode.js` | Singleton boot (`init()` → `new Weeb3No103()` → `start()`); readiness via `ready()`; peer count via the open-WebSocket proxy in `index.html` (`networkState()` carries no live count). |
| `src/App.jsx` | Status + retrieve form (`retrieveBytes`, span stripped) + stream player. |
| `src/swarmFeed.js` | Sequential-feed resolution by SOC probing over `retrieveChunk`; joins the playlist tree with `joinFromChunk`. |
| `src/erasureJoiner.js` | Erasure joiner (swarm-core `rsDecode`) — now used **only** for the playlist tree. |
| `src/swarmHlsLoader.js` | hls.js fragment loader; each segment via native `retrieveBytes`. |
| `vite.config.js` | wasm plugins + **COOP/COEP** (weeb-3 uses SharedArrayBuffer). |

## Notes / limitations

- **`retrieveBytes` framing**: returns `span(8) ‖ data`; the app strips the leading
  8-byte span to get byte-exact content (verified: byte 8 = `0x47` MPEG-TS sync).
- **Native streaming (`attachStream`) not used**: it's coupled to weeb-3's
  `/weeb-3/` service-worker deployment (see table). The hybrid avoids it entirely.
- **Native feeds (`acquireFeedBytes`) not used**: incompatible with beebridge's
  sequential feeds. If a stream uses weeb-3's own feed convention, the native path
  would apply.
