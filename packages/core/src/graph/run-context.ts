/**
 * Per-run context and cursor for the graph engine. The context holds what
 * stays fixed for one run; the cursor holds where the run is and what it
 * has produced so far, so a run can be continued from any cursor.
 */

import type { TokenUsage } from "@tuttiai/types";
import type { AgentRunner } from "../agent-runner.js";
import type {
  GraphConfig,
  GraphEdge,
  GraphEvent,
  GraphNode,
  GraphRunResult,
  NodeResult,
  RunOptions,
} from "./types.js";

/** Default per-node visit cap. */
const DEFAULT_MAX_NODE_VISITS = 5;

/** @internal What stays fixed for one graph run. */
export interface RunContext {
  config: GraphConfig;
  runner: AgentRunner;
  nodeMap: Map<string, GraphNode>;
  edgesBySource: Map<string, GraphEdge[]>;
  maxVisits: number;
  hasStateSchema: boolean;
  startTime: number;
  /** Emits an event, stamped with the run's session_id when it has one. */
  emit: (event: GraphEvent) => void;
}

/** @internal Where a graph run is, and what it has produced so far. */
export interface RunCursor {
  /** Node to execute next, or END. */
  node_id: string;
  /** Input for that node. */
  input: string;
  visits: Map<string, number>;
  outputs: Map<string, NodeResult>;
  path: string[];
  usage: TokenUsage;
  state: Record<string, unknown>;
}

/** How the caller observes a run. */
export interface RunHooks {
  options: RunOptions;
  onEvent?: (event: GraphEvent) => void;
}

function indexEdges(edges: GraphEdge[]): Map<string, GraphEdge[]> {
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.from) ?? [];
    list.push(edge);
    edgesBySource.set(edge.from, list);
  }
  return edgesBySource;
}

/**
 * @internal Build the fixed context of one run.
 *
 * @param config - Validated graph configuration.
 * @param runner - AgentRunner used to execute each node's agent.
 * @param hooks - Run options and the optional event callback.
 */
export function createRunContext(
  config: GraphConfig,
  runner: AgentRunner,
  hooks: RunHooks,
): RunContext {
  const startTime = Date.now();
  // Stamp every emitted event with the run's session_id (when one was
  // provided) so a global subscriber can correlate events with a run.
  const sessionId = hooks.options.session_id;
  const onEvent = hooks.onEvent;
  const emit = (event: GraphEvent): void => {
    if (sessionId !== undefined && event.session_id === undefined) {
      onEvent?.({ ...event, session_id: sessionId });
    } else {
      onEvent?.(event);
    }
  };
  return {
    config,
    runner,
    nodeMap: new Map(config.nodes.map((n) => [n.id, n])),
    edgesBySource: indexEdges(config.edges),
    maxVisits: hooks.options.max_node_visits ?? DEFAULT_MAX_NODE_VISITS,
    hasStateSchema: !!config.state,
    startTime,
    emit,
  };
}

function initialState(config: GraphConfig, options: RunOptions): Record<string, unknown> {
  if (config.state) {
    // The state schema describes the graph's shared state object (see
    // GraphConfig.state), so its parsed output is that record.
    return (
      options.initial_state
        ? config.state.parse(options.initial_state)
        : config.state.parse({})
    ) as Record<string, unknown>;
  }
  return options.initial_state ? { ...options.initial_state } : {};
}

/**
 * @internal A cursor at the entrypoint of a fresh run.
 *
 * @throws Whatever the state schema throws on an invalid initial state.
 */
export function startCursor(config: GraphConfig, input: string, options: RunOptions): RunCursor {
  return {
    node_id: config.entrypoint,
    input,
    visits: new Map(),
    outputs: new Map(),
    path: [],
    usage: { input_tokens: 0, output_tokens: 0 },
    state: initialState(config, options),
  };
}

/** @internal The aggregate result of a run that reached END. */
export function buildResult(ctx: RunContext, cursor: RunCursor): GraphRunResult {
  const lastNodeId = cursor.path.at(-1);
  const finalOutput = lastNodeId ? (cursor.outputs.get(lastNodeId)?.output ?? "") : "";
  return {
    outputs: Object.fromEntries(cursor.outputs),
    path: cursor.path,
    final_output: finalOutput,
    total_usage: cursor.usage,
    duration_ms: Date.now() - ctx.startTime,
    ...(ctx.hasStateSchema ? { final_state: cursor.state } : {}),
  };
}
