// Emits both consumption shapes from one source:
//   dist/swarm-telemetry.esm.js   — for bundlers / import
//   dist/swarm-telemetry.iife.js  — for <script src>, self-configuring
//
// esbuild comes in via Vite in the parent project, so this adds no dependency.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const ESBUILD = "../node_modules/.bin/esbuild";
mkdirSync("dist", { recursive: true });

const common = ["--bundle", "--target=es2020", "--minify", "--sourcemap"];

execFileSync(ESBUILD, ["src/index.js", ...common, "--format=esm", "--outfile=dist/swarm-telemetry.esm.js"], {
  stdio: "inherit",
});
execFileSync(ESBUILD, ["src/auto.js", ...common, "--format=iife", "--outfile=dist/swarm-telemetry.iife.js"], {
  stdio: "inherit",
});
console.log("built dist/swarm-telemetry.{esm,iife}.js");
