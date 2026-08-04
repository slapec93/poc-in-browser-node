import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

// weeb-3 is a wasm-bindgen module that uses SharedArrayBuffer + wasm threads,
// so the page MUST be cross-origin isolated (COOP/COEP). These headers apply
// in dev + preview; a production host/CDN must send the same two headers.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  plugins: [react(), wasm(), topLevelAwait()],
  // Don't let Vite's dep pre-bundler touch the wasm glue — it breaks the
  // relative wasm URL resolution.
  optimizeDeps: { exclude: ["@lat-murmeldjur/weeb_3"] },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
});
