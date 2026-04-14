/**
 * Fluent builder for constructing a {@link GraphConfig}.
 *
 * @example
 * ```typescript
 * const config = defineGraph("planner")
 *   .node("planner", plannerAgent)
 *   .node("coder", coderAgent)
 *   .node("qa", qaAgent, { description: "Quality check" })
 *   .edge("planner", "coder")
 *   .edge("coder", "qa")
 *   .edge("qa", "coder", {
 *     condition: (r) => r.output.includes("needs fix"),
 *     label: "retry",
 *   })
 *   .edge("qa", END, { label: "approved" })
 *   .build();
 *
 * const graph = new TuttiGraph(config, runner);
 * ```
 */

import type { AgentConfig } from "@tuttiai/types";
import type { ZodType } from "zod";
import type { GraphConfig, GraphEdge, GraphNode, NodeResult } from "./types.js";
import { END } from "./types.js";

/** Options accepted by {@link GraphBuilder.edge}. */
export interface EdgeOptions {
  /** Predicate evaluated against the source node's result. */
  condition?: (result: NodeResult) => boolean | Promise<boolean>;
  /** Human-readable label for visualization. */
  label?: string;
  /** Mark as a parallel fork edge. */
  parallel?: boolean;
}

/** Options accepted by {@link GraphBuilder.node}. */
export interface NodeOptions {
  /** Human-readable description for visualization. */
  description?: string;
  /** Mark as a merge/join point for parallel branches. */
  merge?: boolean;
}

/**
 * Fluent builder that accumulates nodes and edges, then produces a
 * validated {@link GraphConfig} via {@link build}.
 */
export class GraphBuilder {
  private readonly entrypoint: string;
  private readonly nodes: GraphNode[] = [];
  private readonly edges: GraphEdge[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private stateSchema?: ZodType<unknown, any, any>;

  constructor(entrypoint: string) {
    this.entrypoint = entrypoint;
  }

  /** Add a node to the graph. */
  node(id: string, agent: AgentConfig, options: NodeOptions = {}): this {
    this.nodes.push({
      id,
      agent,
      description: options.description,
      merge: options.merge,
    });
    return this;
  }

  /** Add a directed edge between two nodes (or to {@link END}). */
  edge(from: string, to: string | typeof END, options: EdgeOptions = {}): this {
    this.edges.push({
      from,
      to,
      condition: options.condition,
      label: options.label,
      parallel: options.parallel,
    });
    return this;
  }

  /** Set the shared state Zod schema for the graph. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state(schema: ZodType<unknown, any, any>): this {
    this.stateSchema = schema;
    return this;
  }

  /** Produce the final {@link GraphConfig}. */
  build(): GraphConfig {
    return {
      entrypoint: this.entrypoint,
      nodes: [...this.nodes],
      edges: [...this.edges],
      ...(this.stateSchema ? { state: this.stateSchema } : {}),
    };
  }
}

/**
 * Shorthand entry point for the builder DSL.
 *
 * @param entrypoint - Node ID where execution begins.
 * @returns A new {@link GraphBuilder}.
 *
 * @example
 * ```typescript
 * const config = defineGraph("start")
 *   .node("start", agentA)
 *   .node("end", agentB)
 *   .edge("start", "end")
 *   .edge("end", END)
 *   .build();
 * ```
 */
export function defineGraph(entrypoint: string): GraphBuilder {
  return new GraphBuilder(entrypoint);
}
