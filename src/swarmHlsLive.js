// Live (and VOD) hls.js loaders backed by the in-browser node + a Swarm feed.
//
// - PlaylistLoader re-resolves the feed to the CURRENT m3u8 on every hls.js
//   (re)load. A live playlist has no #EXT-X-ENDLIST, so hls.js keeps reloading
//   the level and thereby picks up new segments as the feed advances.
// - FragmentLoader fetches each segment reference on demand through the node.
//
// The same loaders serve VOD too: a VOD m3u8 carries #EXT-X-ENDLIST, so hls.js
// loads the playlist once and stops reloading.

const REF_RE = /([0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?)/;

function newStats() {
  return {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 },
    parsing: { start: 0, end: 0 },
    buffering: { start: 0, first: 0, end: 0 },
  };
}

/**
 * @param {() => Promise<{index:number, text:string}>} getManifest
 * @param {(ref:string) => Promise<Uint8Array>} fetchSegment
 * @param {{onManifest?:Function, onSegment?:Function}} [opts]
 */
export function createLiveLoaders(getManifest, fetchSegment, opts = {}) {
  const { onManifest, onSegment } = opts;
  const inflight = new Map(); // ref -> Promise (dedup concurrent requests)

  const PlaylistLoader = class {
    constructor(config) { this.config = config; this.stats = newStats(); this._aborted = false; }
    destroy() {}
    abort() { this._aborted = true; this.stats.aborted = true; }
    load(context, _config, callbacks) {
      const stats = this.stats;
      stats.loading.start = performance.now();
      getManifest()
        .then(({ index, text }) => {
          if (this._aborted) return;
          onManifest?.({ index, text });
          const now = performance.now();
          stats.loading.first = now;
          stats.loading.end = now;
          stats.loaded = text.length;
          stats.total = text.length;
          callbacks.onSuccess({ url: context.url, data: text, code: 200 }, stats, context, null);
        })
        .catch((err) => {
          if (this._aborted) return;
          callbacks.onError?.({ code: 0, text: String(err?.message || err) }, context, null, stats);
        });
    }
  };

  const FragmentLoader = class {
    constructor(config) { this.config = config; this.stats = newStats(); this._aborted = false; }
    destroy() {}
    abort() { this._aborted = true; this.stats.aborted = true; }
    load(context, _config, callbacks) {
      const stats = this.stats;
      stats.loading.start = performance.now();
      const m = REF_RE.exec(context.url);
      if (!m) {
        callbacks.onError({ code: 0, text: `no swarm ref in ${context.url}` }, context, null, stats);
        return;
      }
      const ref = m[1].toLowerCase();
      const t0 = performance.now();
      let p = inflight.get(ref);
      if (!p) { p = fetchSegment(ref); inflight.set(ref, p); }
      p.then((bytes) => {
        inflight.delete(ref);
        if (this._aborted) return;
        onSegment?.({ hex: ref, bytes: bytes.length, ms: Math.round(performance.now() - t0) });
        const now = performance.now();
        stats.loading.first = now;
        stats.loading.end = now;
        stats.loaded = bytes.length;
        stats.total = bytes.length;
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        callbacks.onSuccess({ url: context.url, data: ab }, stats, context, null);
      }).catch((err) => {
        inflight.delete(ref);
        if (this._aborted) return;
        callbacks.onError({ code: 0, text: String(err?.message || err) }, context, null, stats);
      });
    }
  };

  return { PlaylistLoader, FragmentLoader };
}
