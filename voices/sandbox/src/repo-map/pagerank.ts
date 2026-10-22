/**
 * Personalised PageRank by power iteration.
 */

/** Input for {@link personalisedPageRank}. */
export interface PageRankInput {
  nodes: readonly string[];
  /** `edges.get(a).get(b)` is the weight of the edge from a to b. */
  edges: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Where a random surfer restarts. Weights need not sum to 1. Uniform
   * over every node when absent or empty.
   */
  personalisation?: ReadonlyMap<string, number>;
}

/** Probability of following an edge rather than restarting. */
export const DAMPING = 0.85;
const MAX_ITERATIONS = 100;
const TOLERANCE = 1e-9;

function restartVector(input: PageRankInput): Float64Array {
  const n = input.nodes.length;
  const raw = Float64Array.from(input.nodes, (node) => input.personalisation?.get(node) ?? 0);
  const total = raw.reduce((sum, w) => sum + w, 0);
  if (total <= 0) return raw.fill(1 / n);
  return raw.map((w) => w / total);
}

interface Matrix {
  /** Incoming edges per node as [source index, share of the source's out-weight]. */
  incoming: Array<Array<[number, number]>>;
  /** Whether each node has no outgoing edge. */
  dangling: boolean[];
}

function normalise(input: PageRankInput): Matrix {
  const index = new Map(input.nodes.map((node, i) => [node, i]));
  const incoming = input.nodes.map((): Array<[number, number]> => []);
  const dangling = input.nodes.map((node, from) => {
    const row = [...(input.edges.get(node) ?? new Map<string, number>())]
      .map(([to, w]): [number, number] => [index.get(to) ?? -1, w])
      .filter(([to, w]) => to >= 0 && w > 0);
    const total = row.reduce((sum, [, w]) => sum + w, 0);
    for (const [to, w] of row) incoming.at(to)?.push([from, w / total]);
    return row.length === 0;
  });
  return { incoming, dangling };
}

function step(m: Matrix, rank: Float64Array, restart: Float64Array): Float64Array {
  const dangling = m.dangling.reduce((sum, d, i) => sum + (d ? (rank.at(i) ?? 0) : 0), 0);
  // Rank held by nodes with no out-edges, and the restart mass, are
  // spread by the personalisation vector, as networkx does.
  const spread = DAMPING * dangling + (1 - DAMPING);
  return Float64Array.from(m.incoming, (edges, i) => {
    const flow = edges.reduce((sum, [from, share]) => sum + (rank.at(from) ?? 0) * share, 0);
    return DAMPING * flow + spread * (restart.at(i) ?? 0);
  });
}

/**
 * Rank the nodes of a weighted directed graph.
 *
 * @param input - Nodes, weighted edges and an optional personalisation.
 * @returns Each node's rank; the ranks sum to 1.
 */
export function personalisedPageRank(input: PageRankInput): Map<string, number> {
  const n = input.nodes.length;
  if (n === 0) return new Map();
  const restart = restartVector(input);
  const m = normalise(input);
  let rank: Float64Array = Float64Array.from(restart);
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const next = step(m, rank, restart);
    const delta = next.reduce((sum, v, j) => sum + Math.abs(v - (rank.at(j) ?? 0)), 0);
    rank = next;
    if (delta < TOLERANCE * n) break;
  }
  return new Map(input.nodes.map((node, i) => [node, rank.at(i) ?? 0]));
}
