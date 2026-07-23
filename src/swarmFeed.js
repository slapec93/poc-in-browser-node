// Resolve a beebridge / stream-over-swarm stream to its HLS playlist + segments,
// using only the in-browser node's `retrieveChunk`.
//
// Scheme (reverse-engineered + verified against mainnet):
//   watch URL  #/watch/video/<owner>/<uuid>
//   topic      = keccak256(utf8(uuid))                         (bee-js Topic.fromString)
//   identifier = keccak256(topic ‖ uint64_BE(index))           (bee-js sequential feed)
//   SOC addr   = keccak256(identifier ‖ owner[20])             (single-owner chunk)
//   SOC chunk  = id(32) ‖ sig(65) ‖ <content root chunk>       (payload at byte 97)
//   content    = the HLS #EXTM3U playlist (index N = latest / VOD)
//   segments   = /bytes/<hex> MPEG-TS files (erasure-coded)
import { keccak256 } from "js-sha3";
import { joinFromChunk } from "./erasureJoiner.js";

// weeb-3's retrieveChunk returns a SOC already UNWRAPPED to its inner content
// chunk (span + payload) — it strips the 32-byte id + 65-byte signature. So the
// returned chunk IS the content root chunk; we do NOT slice a header off.
const MIN_CONTENT_CHUNK = 8 + 32; // span + at least one ref/leaf byte-run

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

/** Parse `…/#/watch/video/<owner>/<uuid>` (host-agnostic: eth.limo, beebridge, …). */
export function parseWatchUrl(url) {
  const m = url.match(/watch\/video\/(0x)?([0-9a-fA-F]{40})\/([0-9a-fA-F-]{16,})/);
  if (!m) return null;
  return { owner: m[2].toLowerCase(), uuid: m[3] };
}

export function feedTopicHex(uuid) {
  return keccak256(new TextEncoder().encode(uuid));
}

function socAddressHex(topicBytes, ownerBytes, index) {
  const idBytes = hexToBytes(keccak256(concat(topicBytes, u64be(index))));
  return keccak256(concat(idBytes, ownerBytes));
}

// retrieveChunk wrapped so a "missing" chunk fails fast during index probing.
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
 * Find the latest feed index (exponential probe up to first miss, then binary
 * search). Returns { index, soc } for the newest update, or null if none.
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

  // Find an anchor: the lowest present index. Feeds don't always start at 0
  // (e.g. index 0 missing / expired, first update at index 1).
  let anchor = -1;
  for (let i = 0; i <= 5; i++) {
    if (await get(i)) {
      anchor = i;
      break;
    }
  }
  if (anchor < 0) return null;

  // Exponential search upward from the anchor for the first absent index…
  let lo = anchor;
  let hi = anchor + 1;
  while (await get(hi)) {
    lo = hi;
    hi = anchor + (hi - anchor) * 2;
    if (hi > 1 << 22) break;
  }
  // …then binary search for the last present index in (lo present, hi absent].
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

  let index = opts.index;
  let soc;
  if (index != null) {
    soc = await tryChunk(retrieveChunk, socAddressHex(topicBytes, ownerBytes, index), 30000);
  } else {
    const latest = await resolveLatestUpdate(topicBytes, ownerBytes, retrieveChunk, opts);
    if (!latest) throw new Error("stream feed not found on the network");
    index = latest.index;
    soc = latest.soc;
  }
  if (!soc) throw new Error(`no feed update at index ${index}`);

  // retrieveChunk already unwrapped the SOC to its content root chunk.
  const { bytes } = await joinFromChunk(soc, retrieveChunk, opts);
  const text = new TextDecoder().decode(bytes);
  return { index, text, segments: parsePlaylistSegments(text) };
}

/** Extract segment references (bare hex) from an HLS playlist. */
export function parsePlaylistSegments(text) {
  const segs = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const m = t.match(/([0-9a-fA-F]{64}(?:[0-9a-fA-F]{64})?)/); // 64 or 128 hex
    if (m) segs.push(m[1].toLowerCase());
  }
  return segs;
}
