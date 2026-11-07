import type { ScoreConfig } from "@tuttiai/types";

type Agents = ScoreConfig["agents"];

/**
 * Ids of the non-entry agents that list at least one delegate. With
 * `nested_delegation` on, these get the `delegate_to_agent` tool as well.
 *
 * @param agents - The score's agents.
 * @param entryId - Id of the entry agent, which delegates anyway.
 * @returns The ids, in score order.
 */
export function nestedDelegators(agents: Agents, entryId: string): string[] {
  return Object.entries(agents)
    .filter(([id, agent]) => id !== entryId && (agent.delegates?.length ?? 0) > 0)
    .map(([id]) => id);
}

/**
 * Find a cycle in a delegation graph, such as `a` delegating to `b` and `b`
 * back to `a`, which would let a run delegate in a loop.
 *
 * @param graph - Each agent id mapped to the ids it delegates to.
 * @returns The cycle as a list of ids that starts and ends with the same id, or undefined.
 */
export function findDelegationCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const done = new Set<string>();
  const visit = (id: string, trail: string[]): string[] | undefined => {
    const at = trail.indexOf(id);
    if (at >= 0) return [...trail.slice(at), id];
    if (done.has(id)) return undefined;
    for (const next of graph.get(id) ?? []) {
      const cycle = visit(next, [...trail, id]);
      if (cycle) return cycle;
    }
    done.add(id);
    return undefined;
  };
  for (const id of graph.keys()) {
    const cycle = visit(id, []);
    if (cycle) return cycle;
  }
  return undefined;
}

/**
 * Check a score's delegation graph before nested delegation is switched on:
 * every `delegates[]` id must name an agent, and no chain may loop.
 *
 * @param agents - The score's agents.
 * @throws {Error} Naming the unknown id or the cycle, with a fix hint.
 */
export function validateDelegationGraph(agents: Agents): void {
  const graph = new Map(Object.entries(agents).map(([id, agent]) => [id, agent.delegates ?? []]));
  const available = [...graph.keys()].join(", ");
  for (const [id, delegates] of graph) {
    const unknown = delegates.find((d) => !graph.has(d));
    if (unknown !== undefined) {
      throw new Error(
        `nested_delegation: agent "${id}" delegates to unknown agent "${unknown}". Available: ${available}`,
      );
    }
  }
  const cycle = findDelegationCycle(graph);
  if (cycle) {
    throw new Error(
      `nested_delegation: delegation cycle ${cycle.join(" -> ")}. ` +
        `Remove one of these delegates[] entries, or turn nested_delegation off.`,
    );
  }
}
