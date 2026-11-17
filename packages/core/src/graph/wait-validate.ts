/**
 * Construction-time validation of {@link GraphConfig.waits}.
 *
 * Experimental: wait nodes are declared and checked here, but the engine
 * does not execute them yet (see {@link assertNoWaitNodes}).
 */

import type { GraphConfig } from "./types.js";
import { GraphValidationError } from "./errors.js";
import { WaitNodeSchema, type WaitNode } from "./wait.js";

/** Deepest nesting accepted in a `match` object. */
const MAX_MATCH_DEPTH = 32;

/** Keys that would reach an object's prototype when copied. */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function fail(nodeId: string, field: string, issue: string): never {
  throw new GraphValidationError(
    `Wait node "${nodeId}": invalid ${field}: ${issue}`,
    { node_id: nodeId, field, issue },
  );
}

function idOf(raw: unknown, index: number): string {
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id: unknown = raw.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return `waits[${index}]`;
}

/** Bounded walk: rejects deep nesting and prototype keys before Zod recurses. */
function checkMatchShape(value: unknown, depth: number): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if (depth > MAX_MATCH_DEPTH) return `nesting deeper than ${MAX_MATCH_DEPTH}`;
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) return `reserved key "${key}"`;
    const issue = checkMatchShape(Reflect.get(value, key), depth + 1);
    if (issue) return issue;
  }
  return undefined;
}

function preflightMatch(nodeId: string, raw: unknown): void {
  if (typeof raw !== "object" || raw === null || !("match" in raw)) return;
  const match: unknown = raw.match;
  if (match === undefined) return;
  try {
    JSON.stringify(match);
  } catch {
    fail(nodeId, "match", "not JSON-serialisable (cycle, bigint or too deep)");
  }
  const issue = checkMatchShape(match, 1);
  if (issue) fail(nodeId, "match", issue);
}

function parseWait(raw: unknown, index: number): WaitNode {
  const nodeId = idOf(raw, index);
  preflightMatch(nodeId, raw);
  const parsed = WaitNodeSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const field = first && first.path.length > 0 ? first.path.join(".") : "node";
  return fail(nodeId, field, first?.message ?? "invalid wait node");
}

function checkIds(waits: WaitNode[], agentIds: Set<string>): Set<string> {
  const waitIds = new Set<string>();
  for (const w of waits) {
    if (w.id === "__end__") fail(w.id, "id", "\"__end__\" is reserved for END");
    if (agentIds.has(w.id) || waitIds.has(w.id)) {
      throw new GraphValidationError(`Duplicate node IDs: ${w.id}`, {
        duplicates: [w.id],
      });
    }
    waitIds.add(w.id);
  }
  return waitIds;
}

function checkPlacement(config: GraphConfig, waitIds: Set<string>): void {
  if (waitIds.has(config.entrypoint)) {
    fail(config.entrypoint, "entrypoint", "a wait node cannot be the entrypoint");
  }
  for (const edge of config.edges) {
    if (edge.parallel === true && waitIds.has(edge.to)) {
      fail(edge.to, "edge", `parallel edge from "${edge.from}" cannot target a wait node`);
    }
  }
}

/**
 * Validate the wait nodes of a graph and return their ids.
 *
 * @param config - The graph definition; only `waits`, `edges` and `entrypoint` are read.
 * @param agentIds - Ids of the agent nodes, which share the id space with waits.
 * @returns The wait node ids, empty when the graph declares none.
 * @throws {GraphValidationError} Naming the node id and field of the first problem.
 */
export function validateWaitNodes(config: GraphConfig, agentIds: Set<string>): Set<string> {
  const raw: unknown = config.waits;
  if (raw === undefined) return new Set();
  if (!Array.isArray(raw)) fail("waits", "waits", "expected an array of wait nodes");
  const waits = raw.map((w: unknown, i) => parseWait(w, i));
  const waitIds = checkIds(waits, agentIds);
  checkPlacement(config, waitIds);
  const known = new Set([...agentIds, ...waitIds]);
  for (const w of waits) {
    if (w.timeout && w.timeout.to !== "__end__" && !known.has(w.timeout.to)) {
      fail(w.id, "timeout.to", `"${w.timeout.to}" is not a node id or END`);
    }
  }
  return waitIds;
}

/**
 * Run guard until the engine executes wait nodes: refuse rather than run a
 * graph whose edges would silently stop at a wait node.
 *
 * @param config - The graph about to run.
 * @throws {GraphValidationError} When the graph declares any wait node.
 */
export function assertNoWaitNodes(config: GraphConfig): void {
  const count = config.waits?.length ?? 0;
  if (count === 0) return;
  throw new GraphValidationError(
    "Wait nodes are experimental and cannot be executed yet. " +
      "Remove the waits from this graph to run it.",
    { waits: count },
  );
}
