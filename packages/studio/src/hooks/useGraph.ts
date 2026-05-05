import { useEffect, useState } from "react";

import { fetchGraph, type GraphPayload } from "../api.js";

/**
 * Subscribe to `GET /graph`, polling on `intervalMs`.
 *
 * Re-fetches on mount and every interval. Cancels the in-flight request
 * on unmount and on each new tick so a slow server can't backlog
 * stale responses.
 */
export function useGraph(intervalMs = 5000): GraphPayload {
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] });

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | undefined;

    const tick = async (): Promise<void> => {
      controller?.abort();
      controller = new AbortController();
      const next = await fetchGraph(controller.signal);
      if (!cancelled) setGraph(next);
    };

    void tick();
    const handle = setInterval(() => {
      void tick();
    }, intervalMs);

    return (): void => {
      cancelled = true;
      controller?.abort();
      clearInterval(handle);
    };
  }, [intervalMs]);

  return graph;
}
