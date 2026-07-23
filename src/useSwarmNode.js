import { useEffect, useRef, useState } from "react";
import init, { Weeb3No103 } from "@lat-murmeldjur/weeb_3";

// How many peer connections we want before declaring the node ready to serve
// retrieval requests.
const MIN_CONNECTIONS = 1;

// ---------------------------------------------------------------------------
// Module-level singleton boot.
//
// The node is bootstrapped exactly ONCE per tab, the first time any component
// asks for it. Keeping the promise at module scope means React 18 StrictMode's
// double-mount (and any number of components calling the hook) all share the
// same node instead of spinning up a second wasm runtime.
// ---------------------------------------------------------------------------
let bootPromise;

function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      await init(); // loads weeb_3_bg.wasm
      const node = new Weeb3No103();
      // start() is synchronous (returns void); default = mainnet + built-in bootnodes.
      node.start();
      // Expose for console debugging (e.g. `await weeb3.retrieveChunk("...")`).
      if (typeof window !== "undefined") window.weeb3 = node;
      return node;
    })();
  }
  return bootPromise;
}

/**
 * Bootstraps the in-browser Swarm node (weeb-3) on first mount and reports its
 * status. Live peer counts come from readyState(min, 0) (0ms timeout = instant
 * snapshot). retrieveChunk is the working single-chunk retrieval primitive we
 * build the erasure joiner on.
 *
 * @returns {{
 *   node: Weeb3No103|null,
 *   phase: 'booting'|'connecting'|'ready'|'error',
 *   connections: number,
 *   connecting: number,
 *   error: Error|null,
 * }}
 */
export function useSwarmNode() {
  const [node, setNode] = useState(null);
  const [phase, setPhase] = useState("booting");
  const [connections, setConnections] = useState(0);
  const [connecting, setConnecting] = useState(0);
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
            const rs = await n.readyState(MIN_CONNECTIONS, 0);
            if (!alive) return;
            if (typeof rs?.connections === "number") setConnections(rs.connections);
            if (typeof rs?.connecting === "number") setConnecting(rs.connecting);
            if (rs?.ready) setPhase("ready");
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

  return { node, phase, connections, connecting, error };
}
