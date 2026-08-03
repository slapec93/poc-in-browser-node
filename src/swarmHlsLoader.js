// hls.js fragment loading backed by the in-browser weeb-3 node.
//
// hls.js requests fragments one-at-a-time in playback order, so a look-ahead
// prefetcher reconstructs several upcoming segments CONCURRENTLY into a cache;
// when hls asks for the next fragment it's already done (or in flight).
// Each segment is fetched via weeb-3's native retrieveBytes() (`fetchBytes`),
// which decodes erasure coding natively — no client-side joiner.

function newStats() {
  return {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

const SEG_RE = /([0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?)/;

/**
 * @param {string[]} segments - ordered segment references (hex).
 * @param {(hex:string)=>Promise<Uint8Array>} fetchBytes - e.g. (h)=>client.fetch(h, retries)
 * @param {{segConcurrency?:number, lookahead?:number, onSegment?:Function}} [opts]
 */
export function createSwarmStream(segments, fetchBytes, opts = {}) {
  const segConcurrency = opts.segConcurrency ?? 3;
  const lookahead = opts.lookahead ?? 8;
  const onSegment = opts.onSegment;

  const indexOf = new Map(segments.map((h, i) => [h.toLowerCase(), i]));
  const cache = new Map(); // hex -> Promise<Uint8Array>
  let consumed = 0;
  let started = 0;
  let inFlight = 0;

  function startOne(i) {
    const hex = segments[i];
    if (hex == null || cache.has(hex)) return;
    inFlight++;
    const t0 = performance.now();
    const p = fetchBytes(hex)
      .then((bytes) => {
        onSegment?.({ hex, bytes: bytes.length, ms: Math.round(performance.now() - t0) });
        return bytes;
      })
      .finally(() => {
        inFlight--;
        pump();
      });
    cache.set(hex, p);
  }
  function pump() {
    while (inFlight < segConcurrency && started < segments.length && started < consumed + lookahead) {
      startOne(started);
      started++;
    }
  }
  pump();

  function request(hex) {
    const i = indexOf.get(hex);
    if (i != null) {
      consumed = Math.max(consumed, i + 1);
      if (started <= i) started = i;
      pump();
    }
    if (!cache.has(hex)) startOne(i ?? -1);
    return cache.get(hex);
  }

  const SwarmLoader = class {
    constructor(config) {
      this.config = config;
      this.stats = newStats();
      this.context = null;
      this._aborted = false;
    }
    destroy() {}
    abort() {
      this._aborted = true;
      this.stats.aborted = true;
    }
    load(context, _config, callbacks) {
      this.context = context;
      const stats = this.stats;
      stats.loading.start = performance.now();
      const m = SEG_RE.exec(context.url);
      if (!m) {
        callbacks.onError({ code: 0, text: `no swarm ref in ${context.url}` }, context, null, stats);
        return;
      }
      const promise = request(m[1].toLowerCase());
      if (!promise) {
        callbacks.onError({ code: 0, text: `unknown segment ${m[1].slice(0, 12)}` }, context, null, stats);
        return;
      }
      promise
        .then((bytes) => {
          if (this._aborted) return;
          const now = performance.now();
          stats.loading.first = now;
          stats.loading.end = now;
          stats.loaded = bytes.length;
          stats.total = bytes.length;
          cache.delete(context.url && m[1].toLowerCase());
          callbacks.onSuccess(
            { url: context.url, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
            stats, context, null
          );
        })
        .catch((err) => {
          if (this._aborted) return;
          cache.delete(m[1].toLowerCase());
          callbacks.onError({ code: 0, text: String((err && err.message) || err) }, context, null, stats);
        });
    }
  };

  return { SwarmLoader };
}
