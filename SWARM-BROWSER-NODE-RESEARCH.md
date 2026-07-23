# In-browser Swarm node — research handoff

Research for the **DevCon video-stream-over-Swarm** initiative: pick a WASM-compatible
Swarm client that can bootstrap in a browser tab, fetch content from the network, and
play back an HLS stream stored on Swarm.

**Date:** 2026-07-22 · Status: research complete, no POC built yet.

---

## Ticket context (what we're solving)

- Stream playback using **in-browser nodes** (CDN-like, but decentralized) for the DevCon stream.
- Bootstrap a node **on tab creation**, fetch a predefined chunk/bytes address.
- Play back a previous stream. Example artifacts:
  - Streams index: https://streamoverswarm.eth.limo/
  - Example m3u8 (resolves through a **SOC feed**):
    `https://swarm.beebridge.buzz/read/soc/6F2728386F8a47ef5EBe323721188e630Ff0FdE9/0f66985484e653cf98daa1ddf83ca70f6771f9b6510859c1c6f4c930aaf4bcbc`
- Measure browser **download bandwidth**. Baseline: ultra-light Bee node ≈ **670 KB/s**.
- Candidate list source: https://github.com/ethersphere/awesome-swarm#nodes
- Ticket hints: Vertex has the best architecture; weeb-3 is in-house (Abel) so maintainer
  support is better; swarm-core primitives can fill gaps (e.g. feeds) the node lacks.

---

## Comparison table

| Library | Lang | Browser/WASM today? | WASM size | Purpose / maturity | Fetch chunk & bytes | Feeds / SOC | Transport | Maintainer |
|---|---|---|---|---|---|---|---|---|
| **@omnipin/hoverfly** | Rust→WASM | ✅ native + browser | **4.42 MB raw / 1.18 MB gz / 801 KB brotli** (+83 KB JS) | Purpose-built minimal **browser light client** (`discover`/`fetch`/`upload`). Experimental v0.1.9 | bytes/root + manifest-path ✅; no public single-chunk fetch | Feeds **partial** (`feedResolved`, feed-hint cache); **SOC not exposed** | libp2p WebSocket/WSS; needs COOP/COEP | **v1rtl** (omnipin), solo, very active |
| **weeb-3** | Rust→WASM | ✅ browser-only | **4.15 MB raw** (no published gz) (+~100 KB JS) | Swarm client on **pure browser tech**; runs in a Shared Worker (tabs share one node). WIP | bytes + individual chunks ✅; retrieval + pushsync on mainnet | **Feeds ✅ + SOC ✅** (read/write, feed upload) | libp2p WebSocket. ⚠️ Shared Worker unsupported on Chrome/Android | **lat-murmeldjur** (the "Abel" hint — handle only, unverified). Solo |
| **Vertex** | Rust→WASM | ⚠️ demo yes, shipping lib no | **~4.93 MB raw / 1.86 MB gz** — but that's the demo app wasm (see note) | Clean-sheet **full node**, best architecture, wire-compatible. Pre-release, "testnets/lab only" | chunk + bytes ✅; live mainnet up/download in browser demo | **SOC ✅** first-class; **feeds not yet** (feasible on SOC) | forked libp2p secure WebSocket, DoH bootnodes, IndexedDB | **nxm-rs / mfw78**, very active. No npm, zero releases |
| **Ant** | Rust (native) | ❌ no WASM | native ~6–8 MiB | Light node for mobile+desktop; embedded in **Freedom Browser as a native `antd` process** (not WASM) | ✅ chunk + bytes, mainnet | **SOC/GSOC ✅** + PSS; feeds undocumented | native TCP libp2p | **solardev-xyz** org, very active |
| **Kabashira** | Rust + Go (native) | ❌ no WASM | none (source-only, Radicle) | Intentionally minimal **research toolkit**. Experimental | ✅ chunk + file assembly, mainnet | feeds/SOC **planned/partial** | native TCP+Noise+Yamux | **aata.eth**, solo, dormant (last Jan 2026) |

### npm package names
- hoverfly: `@omnipin/hoverfly` (latest 0.1.9)
- weeb-3: `@lat-murmeldjur/weeb_3` — **underscore, not hyphen**; the `weeb-3` name does not exist on npm. Wrapper class `Weeb3No103`.
- Vertex: not on npm.

---

## Key conclusions

1. **Only three are real browser/WASM candidates: hoverfly, weeb-3, Vertex.**
   Ant and Kabashira are native-only. (Correction to a ticket assumption: Ant powers
   Freedom Browser as a *native* process, **not** WASM in the renderer.)

2. **WASM size is a wash.** All three land ~4–5 MB raw / ~0.8–1.9 MB compressed.
   None is disqualified on size; none is small.

3. **The real filter for stream playback is feed/SOC support**, because the m3u8 resolves
   through a SOC feed (`/read/soc/...`):
   - **weeb-3** — only browser lib with **full feeds + SOC read/write today**. Also the
     in-house/maintainer-support option. → lowest-risk default for the POC.
   - **hoverfly** — resolves feeds implicitly but **no SOC API**; you'd backfill feeds
     with swarm-core primitives (the ticket's anticipated fallback).
   - **Vertex** — best architecture + SOC, but **no feeds, no npm, no releases**, and needs
     a custom slim build. Highest integration cost for a POC.

4. **Bandwidth is unmeasured.** None publishes a browser *download* throughput number, so
   the ticket's measurement vs. the 670 KB/s Bee baseline is genuinely new territory —
   we must benchmark it ourselves. (Side data: hoverfly ~400–500 KB/s *upload* in CI;
   Ant demonstrated a 256 MiB mainnet upload.)

### Recommendation
**Start the POC on weeb-3** (lowest functional risk for HLS/SOC, on npm, in-house support).
Keep **hoverfly** as the simpler-API fallback (drive feeds from swarm-core). Treat **Vertex**
as a longer-term architectural bet, not a POC starting point.

### Vertex "stripped WASM" question (answered)
- No published core-only wasm; the 4.93 MB demo is the only linked artifact.
- The demo has **no UI framework** (no Leptos — ~1,300 lines of hand-written web-sys). The
  size is real Swarm core (libp2p fork + alloy + nectar crypto + tokio), **not UI bloat** —
  stripping the UI barely helps. Section split: 86.9% code, 12.4% data, 0 debug.
- Demo is deliberately un-optimized: `Trunk.toml` `wasm_opt = false`, default `release`
  (opt-level=3), no binaryen pass.
- A genuinely lean build is DIY: build `vertex-swarm-node` headless as cdylib, drop the
  `swap`/`swap-chequebook` features (removes alloy chain cone), add `opt-level="z"`,
  `lto=true`, `codegen-units=1`, `strip=true`, binaryen `-Oz`.
  Rough estimate **~2.5–3.5 MB raw / ~1.0–1.4 MB gz** — *estimate, not measured*.
  Even optimized it's in the same gz band as the others, so size is not a reason to pick it.

### Caveats to verify before committing to weeb-3
1. **Shared Worker path is unsupported on Chrome/Android** — confirm the target playback
   environment isn't affected, or use weeb-3's alternate path.
2. **"Abel" = lat-murmeldjur is unverified** — confirm before relying on maintainer support.

---

## Using a wasm-bindgen lib in React (integration cheatsheet)

All candidates are `wasm-bindgen` modules → same pattern. Use **Vite** (Webpack/CRA is painful).

```bash
npm i @omnipin/hoverfly
npm i -D vite-plugin-wasm vite-plugin-top-level-await
```

```js
// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

export default defineConfig({
  plugins: [react(), wasm(), topLevelAwait()],
  optimizeDeps: { exclude: ["@omnipin/hoverfly"] },
  server: {
    // REQUIRED: these libs use SharedArrayBuffer + wasm threads → page must be
    // cross-origin isolated. Prod host/CDN must send these too.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});
```

> ⚠️ #1 gotcha: COEP `require-corp` blocks every cross-origin resource that lacks CORP/CORS
> headers (images, fonts, 3rd-party scripts). Plan asset hosting accordingly.

```jsx
// useSwarmNode.js — bootstrap once on tab creation, shared across components
import { useEffect, useState } from "react";
import init, { HoverflyClient } from "@omnipin/hoverfly";

let bootPromise; // module-level → runs once, dedupes React 18 StrictMode double-mount

function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await init();                 // loads hoverfly_bg.wasm
      const client = new HoverflyClient();
      await client.discover("/dnsaddr/mainnet.ethswarm.org", 10);
      return client;
    })();
  }
  return bootPromise;
}

export function useSwarmNode() {
  const [client, setClient] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    boot().then(c => alive && setClient(c)).catch(e => alive && setError(e));
    return () => { alive = false; };
  }, []);
  return { client, ready: !!client, error };
}
```

```jsx
// usage
const { client, ready } = useSwarmNode();
// const bytes = await client.fetch("<root-hex-address>", 5);
```

**weeb-3 difference:** runs the client inside a Shared Web Worker; you import its wrapper
(`Weeb3No103`) and talk to the worker instead of holding a client on the main thread. Same
`init()` + COOP/COEP requirements. ⚠️ Shared Workers unsupported on Chrome/Android.

### hoverfly public API (from `hoverfly.d.ts` v0.1.9)
`HoverflyClient`: `fetch(root_hex, max_retries)`, `fetchManifestPath(root_hex, path, retries)`,
`listManifest`, `upload`/`uploadFile`/`uploadCollection`, `discover(bootstrap, wait_secs)`,
`start`, `prewarmSessions`, `connectedPeerCount`, `peerCount`, `enableChunkStore(db_name)`
(IndexedDB cache), `exportPeers`/`loadPeers`, `exportFeedHints`/`loadFeedHints`.
Also: `Hasher` (BMT + proofs), `ContentChunk`, `splitFile`, `hashChunkData`, `getConstants`.

---

## Suggested next steps

1. Scaffold Vite + React POC on **weeb-3** (fallback: hoverfly). Bootstrap node on mount,
   fetch the predefined bytes address end-to-end.
2. Wire the m3u8 SOC feed → resolve playlist → feed segments to an HLS player (hls.js /
   MediaSource) from Swarm.
3. Benchmark **download bandwidth** in-browser; compare to the 670 KB/s Bee baseline.
4. If the chosen node lacks a needed primitive (e.g. feed writes), fill it with swarm-core.

## Sources
- awesome-swarm: https://github.com/ethersphere/awesome-swarm#nodes
- hoverfly: https://github.com/omnipin/hoverfly · https://www.npmjs.com/package/@omnipin/hoverfly
- weeb-3: https://github.com/lat-murmeldjur/weeb-3 · https://www.npmjs.com/package/@lat-murmeldjur/weeb_3
- Vertex: https://github.com/nxm-rs/vertex · demo https://nxm-rs.github.io/vertex/
- Ant: https://github.com/solardev-xyz/ant
- Kabashira: Radicle `rad:z41Aa98xcURaZQnV2Lrio1SoX3Tjd`
