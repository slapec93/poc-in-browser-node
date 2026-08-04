import { useEffect, useRef, useState } from "react";
import init, { Weeb3No103 } from "@lat-murmeldjur/weeb_3";

// How many peer connections we want before declaring the node ready to serve
// retrieval requests.
const MIN_CONNECTIONS = 1;

// ---------------------------------------------------------------------------
// Module-level singleton boot — one node per tab, shared across StrictMode
// mounts. As of weeb-3 0.0.32x the client does erasure decoding, feeds, and HLS
// streaming natively, so the app no longer carries a client-side joiner / feed
// resolver / HLS loader — it just drives the node's own API.
// ---------------------------------------------------------------------------
let bootPromise;
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await init(); // loads weeb_3_bg.wasm
      const node = new Weeb3No103();
      node.start(); // synchronous; default = mainnet + browser-dialable bootnodes
      if (typeof window !== "undefined") window.weeb3 = node;
      return node;
    })();
  }
  return bootPromise;
}

// networkState() returns a plain object; pull the connected-peer count out of it
// defensively (field name may vary across releases).
function pickConnections(ns) {
  if (!ns || typeof ns !== "object") return undefined;
  for (const k of ["connections", "connected", "connectedPeers", "peers", "population", "connectionCount", "count"]) {
    if (typeof ns[k] === "number") return ns[k];
  }
  return undefined;
}

/**
 * Bootstraps the in-browser Swarm node (weeb-3) on first mount and reports its
 * status. Uses the node's own `ready(min, timeout)` boolean for readiness and
 * `networkState()` for the live peer count.
 *
 * @returns {{ node: Weeb3No103|null, phase: string, connections: number, networkState: object|null, error: Error|null }}
 */
export function useSwarmNode() {
  const [node, setNode] = useState(null);
  const [phase, setPhase] = useState("booting");
  const [connections, setConnections] = useState(0);
  const [networkState, setNetworkState] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => {
    let alive = true;
    boot()
      .then((n) => {
        if (!alive) return;
        setNode(n);
        setPhase("connecting");
        pollRef.current = setInterval(async () => {
          try {
            const ns = await n.networkState();
            if (!alive) return;
            setNetworkState(ns);
            // networkState() carries network config, not a live peer count, so
            // fall back to the open-WebSocket count (weeb-3 dials peers over wss).
            const c = pickConnections(ns) ?? (typeof window !== "undefined" && window.wsCount ? window.wsCount() : undefined);
            if (typeof c === "number") setConnections(c);
            const ready = await n.ready(MIN_CONNECTIONS, 0);
            if (!alive) return;
            if (ready) setPhase("ready");
          } catch {
            /* transient — keep polling */
          }
        }, 1000);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setPhase("error");
      });
    return () => {
      alive = false;
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  return { node, phase, connections, networkState, error };
}
