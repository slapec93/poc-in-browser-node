// IIFE entry: config comes off the <script data-*> tag (see README.md).
// Instance exposed as window.swarmTelemetry.

import { createTelemetry } from "./index.js";

function currentScript() {
  if (document.currentScript) return document.currentScript;
  // currentScript is null on deferred/async load.
  const all = document.querySelectorAll("script[data-endpoint]");
  return all.length ? all[all.length - 1] : null;
}

function readConfig(el) {
  if (!el) return {};
  const d = el.dataset || {};
  const cfg = {};
  if (d.endpoint) cfg.endpoint = d.endpoint;
  if (d.label) cfg.label = d.label;
  if (d.gw) cfg.gw = d.gw;
  if (d.vid) cfg.vid = d.vid;
  if (d.heartbeatMs) cfg.heartbeatMs = Number(d.heartbeatMs) || undefined;
  if (d.stallPollMs) cfg.stallPollMs = Number(d.stallPollMs) || undefined;
  if (d.stallRatio) cfg.stallRatio = Number(d.stallRatio) || undefined;
  if (d.debug) cfg.debug = d.debug !== "false";
  return cfg;
}

const script = currentScript();
const config = readConfig(script);
const auto = !script || script.dataset.auto !== "false";

const telemetry = createTelemetry(config);
globalThis.swarmTelemetry = telemetry;

if (auto) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => telemetry.autoAttach(), { once: true });
  } else {
    telemetry.autoAttach();
  }
}

export { createTelemetry };
export default telemetry;
