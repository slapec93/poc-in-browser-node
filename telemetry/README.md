# swarm-stream-telemetry

Drop-in playback telemetry for Swarm video pages. Dependency-free, ~5 kB minified,
reports to a Cloudflare Worker collector (see [`../collector`](../collector)).

Works on any page that plays video. A weeb-3 node is optional — if one is present,
peer count is reported alongside playback; if not, that field is simply absent.
Nothing here assumes a framework, a player, or a particular page structure.

## Drop-in

```html
<script src="swarm-telemetry.iife.js"
        data-endpoint="https://your-worker.workers.dev/e"></script>
```

That's the whole integration. It finds the page's `<video>` — now, or whenever the
player creates it — and starts reporting.

| attribute | default | meaning |
|---|---|---|
| `data-endpoint` | — | collector URL. **Required**; without it the module stays inert rather than throwing |
| `data-label` | `?l=` param | tags the session, e.g. per distribution link |
| `data-gw` | `location.host` | the gateway the viewer arrived through |
| `data-vid` | from page URL | video id; parsed from `/watch/video/<owner>/<uuid>` or `?v=` |
| `data-heartbeat-ms` | `30000` | interval for in-progress rows |
| `data-stall-poll-ms` | `1000` | stall sampling window |
| `data-stall-ratio` | `0.25` | below this share of expected progress, playback counts as hanging |
| `data-debug` | `false` | log every beacon to the console |
| `data-auto` | `true` | set `false` to attach manually via `window.swarmTelemetry` |

## As a module

```js
import { createTelemetry } from "swarm-stream-telemetry";

const telemetry = createTelemetry({
  endpoint: "https://your-worker.workers.dev/e",
  vid: uuid,     // optional; otherwise parsed from the URL
  node,          // optional weeb-3 node, for peer count
});

telemetry.attach(videoElement);   // or .autoAttach()
// telemetry.stop();              // emits the final row; also automatic on pagehide
```

## What it reports

One row per event. `type` is one of `view`, `start`, `progress`, `pause`,
`heartbeat`, `complete`, `end`.

| field | meaning |
|---|---|
| `watched` | content actually played, in seconds — excludes stalls and scrubbing |
| `depth` | furthest fraction of the video reached |
| `dur` | duration (0 for live, where duration is `Infinity`) |
| `seeks` | seek count |
| `mark` | milestone for `progress` rows: 25 / 50 / 75 |
| `stalls` | rebuffering interruptions after playback started |
| `stalled` | total seconds lost to those interruptions |
| `ttff` | seconds from attach to first frame — startup wait, counted separately |
| `peers` | connected peers, when a weeb-3 node is available |

`view` fires on attach and is the funnel denominator: opened, may never press play.
`end` fires once per pageview on `pagehide` and carries the final totals — the
collector's watch-behaviour aggregates read those rows only.

## Two design notes worth knowing

**Stalls are detected by polling, not by the `waiting` event.** hls.js — including
the copy weeb-3 uses internally — recovers buffer gaps by nudging `currentTime`,
which fires `seeking`/`seeked` and makes a genuine rebuffer look like a user seek.
Instead this compares media time advanced against wall-clock elapsed, which is
immune to however the player recovers. Duration is measured as the *deficit*
(elapsed minus played), so a window straddling the start of a hang contributes its
stalled part rather than being dropped whole. It errs low: sub-second stutters go
uncounted, because a false "your stream is stuttering" is worse than missing a blink.

**The transport avoids CORS preflight and survives unload.** The body is sent as
`text/plain` (CORS-safelisted, so no preflight — a preflight fired during unload is
routinely dropped) via `fetch({mode:"cors", keepalive:true})`. `sendBeacon` is only
a fallback, because it sends `no-cors`, which a cross-origin-isolated host page
(`COEP: require-corp`) blocks unless the collector sends
`Cross-Origin-Resource-Policy`. The bundled collector does send it.

## Build

```sh
node build.js     # → dist/swarm-telemetry.{esm,iife}.js
```

Uses the esbuild binary from the parent project, so it adds no dependency of its own.
