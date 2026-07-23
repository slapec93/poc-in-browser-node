// Erasure-aware Swarm joiner WITH Reed-Solomon reconstruction.
//
// Bee ≥2.8.1 erasure-codes uploads by default (redundancy MEDIUM): the level is
// packed into the top byte of a chunk's span, and each intermediate node holds
// D data refs followed by P parity refs (one RS group per node). A browser
// light node often can't route to every chunk's neighborhood — so when a DATA
// chunk is unreachable, we fetch that node's PARITY chunks and reconstruct the
// missing shard with Reed-Solomon (swarm-core's rsDecode), exactly as a Bee
// gateway would. This is what lets streams play despite unreachable chunks.
//
// Built on a single-chunk primitive (weeb-3's retrieveChunk), with parallel
// fetching + retry on top for streaming throughput. Erasure math is swarm-core's
// canonical implementation (@upcoming/swarm-core).
import { decodeRedundancyLevel, referenceCount, rsDecode } from "@upcoming/swarm-core/erasure-coding";

const SPAN_SIZE = 8;
const CHUNK_MAX_DATA = 4096;
const SHARD_SIZE = SPAN_SIZE + CHUNK_MAX_DATA; // 4104 — the raw-chunk shard size RS operates on

function toHex(u8) {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}
function readSpanLE(chunk) {
  let v = 0n;
  for (let i = 0; i < SPAN_SIZE; i++) v += BigInt(chunk[i]) << (8n * BigInt(i));
  return v;
}
function isAllZero(bytes) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) return false;
  return true;
}
// Pad a fetched chunk (span + data) to the fixed 4104-byte RS shard.
function padShard(chunk) {
  if (chunk.length === SHARD_SIZE) return chunk;
  const s = new Uint8Array(SHARD_SIZE);
  s.set(chunk.subarray(0, Math.min(chunk.length, SHARD_SIZE)));
  return s;
}
function concatTo(parts, real) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out.subarray(0, real);
}

function makeLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      next();
    });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}

function makeJoiner(retrieveChunk, opts) {
  const concurrency = opts.concurrency ?? 12;
  const refSize = opts.refSize ?? 32;
  const retries = opts.retries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 600;
  const onProgress = opts.onProgress;
  const onReconstruct = opts.onReconstruct;
  const limit = makeLimiter(concurrency);
  const state = { fetched: 0, reconstructed: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Fetch one chunk with retries; throws if it stays unreachable.
  async function getRaw(hex) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const c = await retrieveChunk(hex);
        if (c && c.length >= SPAN_SIZE) {
          state.fetched++;
          onProgress?.(state.fetched);
          return c;
        }
      } catch {
        /* retry */
      }
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
    throw new Error(`chunk unreachable: ${hex.slice(0, 12)}…`);
  }
  // Single fast attempt with a hard timeout, returning a padded RS shard or
  // null. Used for erasure shards: since parity covers a miss, we must NOT wait
  // on weeb-3's slow give-up for an unreachable chunk — we fail fast and let
  // Reed-Solomon reconstruct from parity instead.
  const shardTimeoutMs = opts.shardTimeoutMs ?? 4000;
  async function fetchShard(hex) {
    try {
      const timeout = new Promise((r) => setTimeout(() => r(null), shardTimeoutMs));
      const c = await Promise.race([retrieveChunk(hex), timeout]);
      if (c && c.length >= SPAN_SIZE) {
        state.fetched++;
        onProgress?.(state.fetched);
        return padShard(c);
      }
    } catch {
      /* miss — reconstruct from parity */
    }
    return null;
  }

  async function joinChunk(chunk) {
    const { level, span } = decodeRedundancyLevel(readSpanLE(chunk));
    const real = Number(span);
    const payload = chunk.subarray(SPAN_SIZE);

    // Leaf: the payload IS the data.
    if (real <= CHUNK_MAX_DATA) return payload.subarray(0, real);

    const refHex = (i) => toHex(payload.subarray(i * refSize, i * refSize + 32));

    // No redundancy: walk data refs to the all-zero terminator.
    if (level === 0) {
      const maxRefs = Math.floor(CHUNK_MAX_DATA / refSize);
      const refs = [];
      for (let i = 0; i < maxRefs; i++) {
        const a = payload.subarray(i * refSize, i * refSize + 32);
        if (a.length < 32 || isAllZero(a)) break;
        refs.push(refHex(i));
      }
      const results = await Promise.all(refs.map((hex) => limit(async () => joinChunk(await getRaw(hex)))));
      return concatTo(results, real);
    }

    // Redundancy: one RS group of D data refs + P parity refs.
    const { dataShardCount: D, parityShardCount: P } = referenceCount(span, level, false);

    // Fetch data shards (fast, tolerating unreachable ones — parity covers them).
    const dataShards = await Promise.all(
      Array.from({ length: D }, (_, i) => limit(() => fetchShard(refHex(i))))
    );

    if (dataShards.some((s) => !s)) {
      // Reconstruct missing data shards from parity.
      const missing = dataShards.filter((s) => !s).length;
      const parityShards = await Promise.all(
        Array.from({ length: P }, (_, i) => limit(() => fetchShard(refHex(D + i))))
      );
      // Throws if fewer than D shards total are available (unrecoverable).
      const recovered = rsDecode([...dataShards, ...parityShards], D, P);
      for (let i = 0; i < D; i++) if (!dataShards[i]) dataShards[i] = recovered[i];
      state.reconstructed += missing;
      onReconstruct?.(missing);
    }

    // Descend into each data shard (as a raw chunk) in parallel.
    const results = await Promise.all(dataShards.map((s) => joinChunk(s)));
    return concatTo(results, real);
  }

  return { getRaw, joinChunk, state };
}

export async function joinBytes(rootHex, retrieveChunk, opts = {}) {
  const refSize = rootHex.length > 64 ? 64 : 32;
  const j = makeJoiner(retrieveChunk, { ...opts, refSize });
  const root = await j.getRaw(rootHex);
  const bytes = await j.joinChunk(root);
  return { bytes, chunksFetched: j.state.fetched, reconstructed: j.state.reconstructed };
}

/**
 * Reconstruct bytes from an already-fetched root chunk (span+payload) — used for
 * feed content, where the feed SOC embeds the content's root chunk.
 */
export async function joinFromChunk(rootChunk, retrieveChunk, opts = {}) {
  const j = makeJoiner(retrieveChunk, opts);
  const bytes = await j.joinChunk(rootChunk);
  return { bytes, chunksFetched: j.state.fetched, reconstructed: j.state.reconstructed };
}
