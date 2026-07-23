// Erasure-aware Swarm joiner.
//
// Bee ≥2.8.1 erasure-codes uploads by default (redundancy MEDIUM), which the
// browser clients' built-in bytes-retrieval can't parse: the redundancy level
// is packed into the top byte of a chunk's 8-byte span (span[7] = level | 0x80),
// so a naive joiner reads the span as a ~9-exabyte size and falls apart.
//
// This joiner works on top of a single-chunk retrieval primitive
// (weeb-3's `retrieveChunk(addrHex) -> Uint8Array`, which returns span+payload):
//   1. DecodeSpan — mask the top byte to recover the real data size.
//   2. Walk only the DATA child references, skipping the trailing PARITY refs.
//      (No Reed-Solomon needed as long as the data chunks are retrievable;
//      parity is only required to reconstruct *missing* data chunks.)

const SPAN_SIZE = 8;
const CHUNK_MAX_DATA = 4096;

function toHex(u8) {
  let s = "";
  for (const b of u8) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Decode a chunk's span, masking the erasure-coding level flag out of the top
 * byte. Returns the real data-byte count the chunk (sub)tree covers.
 */
export function decodeSpan(chunk) {
  const span = chunk.subarray(0, SPAN_SIZE);
  const top = span[SPAN_SIZE - 1];
  const encoded = top > 128; // 0x80 bit set => redundancy level encoded
  let real = 0n;
  for (let i = 0; i < SPAN_SIZE; i++) {
    const b = i === SPAN_SIZE - 1 ? (encoded ? 0 : span[i]) : span[i];
    real += BigInt(b) << (8n * BigInt(i));
  }
  return { real: Number(real), level: encoded ? top & 0x7f : 0, encoded };
}

// Minimal concurrency limiter so we don't open thousands of parallel retrievals.
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

/**
 * Reconstruct the bytes at `rootHex` using `retrieveChunk`.
 *
 * @param {string} rootHex - 64-hex (or 128-hex encrypted) bytes root reference.
 * @param {(hex:string)=>Promise<Uint8Array>} retrieveChunk - single-chunk fetch.
 * @param {{concurrency?:number,onProgress?:(fetched:number)=>void}} [opts]
 * @returns {Promise<{bytes:Uint8Array, chunksFetched:number}>}
 */
// Build the shared recursive joiner (used by both joinBytes and joinFromChunk).
function makeJoiner(retrieveChunk, opts) {
  const concurrency = opts.concurrency ?? 12;
  const onProgress = opts.onProgress;
  const refSize = opts.refSize ?? 32; // 64-byte refs => encrypted
  const limit = makeLimiter(concurrency);
  const retries = opts.retries ?? 4;
  const retryDelayMs = opts.retryDelayMs ?? 700;
  const state = { fetched: 0 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Retry unreachable chunks: a browser light node can't always route to a
  // chunk's neighborhood on the first try, but its peer set keeps shifting, so
  // a later attempt often succeeds. (For chunks that stay unreachable, erasure
  // parity would be needed to reconstruct — see README.)
  async function getChunk(hex) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const c = await retrieveChunk(hex);
        if (c && c.length >= SPAN_SIZE) {
          state.fetched++;
          onProgress?.(state.fetched);
          return c;
        }
      } catch {
        /* fall through to retry */
      }
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
    throw new Error(`chunk unreachable after ${retries + 1} tries: ${hex.slice(0, 12)}…`);
  }

  async function joinChunk(chunk) {
    const { real } = decodeSpan(chunk);
    const payload = chunk.subarray(SPAN_SIZE);

    // Leaf: the payload IS the data.
    if (real <= CHUNK_MAX_DATA) return payload.subarray(0, real);

    // Intermediate: payload is [data refs…, parity refs…].
    const refs = [];
    for (let off = 0; off + refSize <= payload.length; off += refSize) {
      refs.push(toHex(payload.subarray(off, off + refSize)));
    }

    // Fetch the first child to learn the per-child subtree capacity, which tells
    // us exactly how many leading refs are DATA (the rest are parity).
    const first = await getChunk(refs[0]);
    const firstSpan = decodeSpan(first).real;
    const dataCount = firstSpan >= real ? 1 : Math.ceil(real / firstSpan);

    const results = new Array(dataCount);
    results[0] = await joinChunk(first);
    await Promise.all(
      refs.slice(1, dataCount).map((hex, i) =>
        limit(async () => {
          results[i + 1] = await joinChunk(await getChunk(hex));
        })
      )
    );

    let total = 0;
    for (const p of results) total += p.length;
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of results) {
      out.set(p, o);
      o += p.length;
    }
    return out.subarray(0, real);
  }

  return { getChunk, joinChunk, state };
}

export async function joinBytes(rootHex, retrieveChunk, opts = {}) {
  const refSize = rootHex.length > 64 ? 64 : 32;
  const j = makeJoiner(retrieveChunk, { ...opts, refSize });
  const root = await j.getChunk(rootHex);
  const bytes = await j.joinChunk(root);
  return { bytes, chunksFetched: j.state.fetched };
}

/**
 * Reconstruct bytes starting from an already-fetched root chunk (span+payload).
 * Used for feed content, where the feed SOC embeds the content's root chunk.
 */
export async function joinFromChunk(rootChunk, retrieveChunk, opts = {}) {
  const j = makeJoiner(retrieveChunk, opts);
  const bytes = await j.joinChunk(rootChunk);
  return { bytes, chunksFetched: j.state.fetched };
}
