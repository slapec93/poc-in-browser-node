// hls.js fragment loading backed by the in-browser Swarm node.
//
// hls.js requests fragments one-at-a-time in playback order, but reconstructing
// a ~1.8 MB erasure-coded segment (~450 chunks) takes ~2-3 s — slower than the
// 2 s of video it represents, so sequential loading falls behind and rebuffers.
//
// createSwarmStream() fixes that with a look-ahead prefetcher: it reconstructs
// several upcoming segments CONCURRENTLY into a cache, so when hls asks for the
// next fragment it's already done (or in flight). Aggregate throughput then
// scales with segConcurrency and stays ahead of realtime.

function newStats() {
  return {
    aborted: false,
    loaded: 0,
    retry: 0,
    total: 0,
    chunkCount: 0,
    bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

const SEG_RE = /([0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?)/;

/**
 * @param {string[]} segments - ordered segment references (hex) from the playlist.
 * @param {(hex:string)=>Promise<Uint8Array>} retrieveChunk
 * @param {Function} joinBytes - (hex, retrieveChunk, opts) => {bytes, chunksFetched}
 * @param {{segConcurrency?:number, chunkConcurrency?:number, lookahead?:number, onSegment?:Function}} [opts]
 * @returns {{ SwarmLoader: any }}
 */
export function createSwarmStream(segments, retrieveChunk, joinBytes, opts = {}) {
  const segConcurrency = opts.segConcurrency ?? 3;
  const chunkConcurrency = opts.chunkConcurrency ?? 16;
  const lookahead = opts.lookahead ?? 8;
  const onSegment = opts.onSegment;

  const indexOf = new Map(segments.map((h, i) => [h.toLowerCase(), i]));
  const cache = new Map(); // hex -> Promise<Uint8Array>
  let consumed = 0; // frontier: highest fragment index hls has requested (+1)
  let started = 0; // next index to prefetch
  let inFlight = 0;

  function startOne(i) {
    const hex = segments[i];
    if (hex == null || cache.has(hex)) return;
    inFlight++;
    const t0 = performance.now();
    const p = joinBytes(hex, retrieveChunk, { concurrency: chunkConcurrency })
      .then(({ bytes, chunksFetched }) => {
        onSegment?.({ hex, bytes: bytes.length, ms: Math.round(performance.now() - t0), chunks: chunksFetched });
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

  pump(); // prime the pump before playback starts

  function request(hex) {
    const i = indexOf.get(hex);
    if (i != null) {
      consumed = Math.max(consumed, i + 1);
      if (started <= i) started = i; // a seek jumped ahead
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
      const hex = m[1].toLowerCase();
      const promise = request(hex);
      if (!promise) {
        callbacks.onError({ code: 0, text: `unknown segment ${hex.slice(0, 12)}` }, context, null, stats);
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
          cache.delete(hex); // free memory once delivered to hls
          callbacks.onSuccess({ url: context.url, data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, stats, context, null);
        })
        .catch((err) => {
          if (this._aborted) return;
          cache.delete(hex);
          callbacks.onError({ code: 0, text: String((err && err.message) || err) }, context, null, stats);
        });
    }
  };

  return { SwarmLoader };
}
