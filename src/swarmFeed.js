// Resolve a beebridge / stream-over-swarm stream to its HLS playlist, using the
// in-browser node's `retrieveChunk`.
//
// Why not weeb-3's native acquireFeedBytes()? It resolves a *different* feed
// convention and returns "not found" for beebridge's bee-js sequential feeds
// (verified). Beebridge feeds ARE alive on the network — they resolve fine by
// probing the sequential-feed SOC addresses directly, which is what we do here.
//
// Scheme (bee-js sequential feed, verified against mainnet):
//   watch URL  #/watch/video/<owner>/<uuid>
//   topic      = keccak256(utf8(uuid))
//   identifier = keccak256(topic ‖ uint64_BE(index))
//   SOC addr   = keccak256(identifier ‖ owner[20])
//   SOC chunk  = retrieveChunk(SOC addr) → content root chunk, already unwrapped
//                by weeb-3. The playlist tree (a long VOD playlist is ~80 KB and
//                erasure-coded) is joined with the erasure joiner.
//   segments   = bytes references (erasure-coded) fetched natively via retrieveBytes
import { keccak256 } from "js-sha3";
import { joinFromChunk } from "./erasureJoiner.js";

const SPAN_SIZE = 8;
const MIN_CONTENT_CHUNK = SPAN_SIZE + 32;

function hexToBytes(hex) {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function u64be(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
}
const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** Parse `…/#/watch/video/<owner>/<uuid>` (host-agnostic). */
export function parseWatchUrl(url) {
  const m = url.match(/watch\/video\/(0x)?([0-9a-fA-F]{40})\/([0-9a-fA-F-]{16,})/);
  return m ? { owner: m[2].toLowerCase(), uuid: m[3] } : null;
}

export function feedTopicHex(uuid) {
  return keccak256(new TextEncoder().encode(uuid));
}

function socAddressHex(topicBytes, ownerBytes, index) {
  const idBytes = hexToBytes(keccak256(concat(topicBytes, u64be(index))));
  return keccak256(concat(idBytes, ownerBytes));
}

async function tryChunk(retrieveChunk, addrHex, timeoutMs) {
  try {
    const timeout = new Promise((r) => setTimeout(() => r(null), timeoutMs));
    const c = await Promise.race([retrieveChunk(addrHex), timeout]);
    return c && c.length >= MIN_CONTENT_CHUNK ? c : null;
  } catch {
    return null;
  }
}

/**
 * Find the latest feed index (anchor scan → exponential probe → binary search).
 * Returns { index, soc } for the newest update, or null if none.
 */
export async function resolveLatestUpdate(topicBytes, ownerBytes, retrieveChunk, opts = {}) {
  const probeTimeout = opts.probeTimeoutMs ?? 6000;
  const onProbe = opts.onProbe;
  const cache = new Map();
  const get = async (i) => {
    if (cache.has(i)) return cache.get(i);
    onProbe?.(i);
    const soc = await tryChunk(retrieveChunk, socAddressHex(topicBytes, ownerBytes, i), probeTimeout);
    cache.set(i, soc);
    return soc;
  };

  let anchor = -1;
  for (let i = 0; i <= 5; i++) {
    if (await get(i)) { anchor = i; break; }
  }
  if (anchor < 0) return null;

  let lo = anchor;
  let hi = anchor + 1;
  while (await get(hi)) {
    lo = hi;
    hi = anchor + (hi - anchor) * 2;
    if (hi > 1 << 22) break;
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (await get(mid)) lo = mid;
    else hi = mid;
  }
  return { index: lo, soc: await get(lo) };
}

/**
 * Resolve the playlist for a stream. Returns { index, text, segments }.
 * `retrieveChunk(hex) -> Promise<Uint8Array>` is the node primitive.
 */
export async function resolvePlaylist(owner, uuid, retrieveChunk, opts = {}) {
  const ownerBytes = hexToBytes(owner);
  const topicBytes = hexToBytes(feedTopicHex(uuid));

  const latest = await resolveLatestUpdate(topicBytes, ownerBytes, retrieveChunk, opts);
  if (!latest) throw new Error("stream feed not found on the network");

  // retrieveChunk already unwrapped the SOC to its content root chunk. The
  // playlist can span multiple (erasure-coded) chunks — a long VOD playlist is
  // ~80 KB — so join the small content tree with the erasure joiner. (Segments
  // are fetched separately via the node's native retrieveBytes.)
  const { bytes } = await joinFromChunk(latest.soc, retrieveChunk, opts);
  const text = new TextDecoder().decode(bytes);
  if (!text.includes("#EXTM3U")) throw new Error("feed did not resolve to an HLS playlist");
  return { index: latest.index, text, segments: parsePlaylistSegments(text) };
}

/**
 * Live resolver for a growing feed. Returns `getManifest()` that yields the
 * CURRENT playlist each call. The first call finds the latest index via the full
 * search; later calls just probe FORWARD from the last-known index (cheap — a
 * live feed grows ~1 index per segment), so hls.js reloads pick up new segments.
 */
export function makeLiveResolver(owner, uuid, retrieveChunk, opts = {}) {
  const ownerBytes = hexToBytes(owner);
  const topicBytes = hexToBytes(feedTopicHex(uuid));
  const timeout = opts.probeTimeoutMs ?? 4000;
  let lastIndex = -1;
  let lastSoc = null;

  return async function getManifest() {
    if (lastIndex < 0) {
      const latest = await resolveLatestUpdate(topicBytes, ownerBytes, retrieveChunk, opts);
      if (!latest) throw new Error("stream feed not found on the network");
      lastIndex = latest.index;
      lastSoc = latest.soc;
    } else {
      let idx = lastIndex;
      let soc = lastSoc;
      for (;;) {
        const next = await tryChunk(retrieveChunk, socAddressHex(topicBytes, ownerBytes, idx + 1), timeout);
        if (!next) break;
        idx += 1;
        soc = next;
      }
      lastIndex = idx;
      lastSoc = soc;
    }
    const { bytes } = await joinFromChunk(lastSoc, retrieveChunk, opts);
    const text = new TextDecoder().decode(bytes);
    if (!text.includes("#EXTM3U")) throw new Error("feed did not resolve to an HLS playlist");
    return { index: lastIndex, text };
  };
}

/** Extract segment references (bare hex) from an HLS playlist. */
export function parsePlaylistSegments(text) {
  const segs = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/([0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?)/);
    if (m) segs.push(m[1].toLowerCase());
  }
  return segs;
}
