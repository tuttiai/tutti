/**
 * Shared fixtures for the wait node tests.
 */

import type { AgentConfig } from "@tuttiai/types";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { TuttiGraph } from "../../src/graph/index.js";
import { END } from "../../src/graph/types.js";
import type { GraphConfig } from "../../src/graph/types.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";

/** Minimal agent config with a given name. */
export function agent(name: string): AgentConfig {
  return { name, model: "test-model", system_prompt: `You are ${name}.`, voices: [] };
}

/** Runner over a mock provider that answers every call with "ok". */
export function runner(): AgentRunner {
  const provider = createMockProvider([textResponse("ok"), textResponse("ok")]);
  return new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
}

/**
 * start -> gate (wait) -> done -> END, with `gate` replaced by `waits`.
 * `waits` is unknown on purpose: the tests feed it what a plain-JS caller
 * could pass, so the cast below stands in for an unchecked caller.
 */
export function configWith(waits: unknown[], extraEdges: GraphConfig["edges"] = []): GraphConfig {
  const base: Omit<GraphConfig, "waits"> = {
    entrypoint: "start",
    nodes: [
      { id: "start", agent: agent("start") },
      { id: "done", agent: agent("done") },
    ],
    edges: [
      { from: "start", to: "gate" },
      { from: "gate", to: "done" },
      { from: "done", to: END },
      ...extraEdges,
    ],
  };
  // Safe for tests only: validation is what is under test, so the value
  // deliberately skips the compile-time check a TypeScript caller gets.
  return { ...base, waits: waits as GraphConfig["waits"] };
}

/** A valid wait node named `gate`, with `overrides` merged in. */
export function gate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "wait", id: "gate", event: "order.paid", ...overrides };
}

/** Construct the graph; throws whatever validation throws. */
export function construct(config: GraphConfig): TuttiGraph {
  return new TuttiGraph(config, runner());
}
