/**
 * Builds runtimes whose agents carry the internal `delegate_to_agent` tool,
 * so tests can reach two levels of delegation without the router.
 */

import type { AgentConfig, LLMProvider, ScoreConfig, TuttiEvent } from "@tuttiai/types";

import { buildDelegateTool } from "../../src/delegation/delegate-tool.js";
import { TuttiRuntime } from "../../src/runtime.js";

/** One agent of a test score. Its system prompt is `MARKER-<id>`. */
export interface TestAgent {
  id: string;
  delegates?: string[];
  streaming?: boolean;
}

/** A `delegate:delta` event. */
export type Delta = Extract<TuttiEvent, { type: "delegate:delta" }>;

function agentConfig(agent: TestAgent, runtime: () => TuttiRuntime, score: ScoreConfig): AgentConfig {
  const config: AgentConfig = {
    name: `${agent.id}-name`,
    model: "test-model",
    system_prompt: `MARKER-${agent.id}`,
    voices: [],
    streaming: agent.streaming ?? true,
  };
  if (!agent.delegates) return config;
  const tool = buildDelegateTool({ runtime, score, callerId: agent.id, callerName: config.name }, agent.delegates);
  return { ...config, voices: [{ name: "delegation", required_permissions: [], tools: [tool] }] };
}

/**
 * A runtime over `agents`, answered by `provider`.
 *
 * @returns The runtime and every event it emitted, in order.
 */
export function delegationRuntime(
  provider: LLMProvider,
  agents: TestAgent[],
): { runtime: TuttiRuntime; events: TuttiEvent[] } {
  let runtime: TuttiRuntime | undefined;
  const get = (): TuttiRuntime => {
    if (!runtime) throw new Error("runtime not built yet");
    return runtime;
  };
  const score: ScoreConfig = { provider, agents: {} };
  score.agents = Object.fromEntries(agents.map((a) => [a.id, agentConfig(a, get, score)]));
  runtime = new TuttiRuntime(score);
  const events: TuttiEvent[] = [];
  runtime.events.onAny((e) => events.push(e));
  return { runtime, events };
}

/** The deltas among `events`. */
export function deltasOf(events: TuttiEvent[]): Delta[] {
  return events.filter((e): e is Delta => e.type === "delegate:delta");
}

/** The types of `events`, keeping only the delegation ones. */
export function delegationTrace(events: TuttiEvent[]): string[] {
  return events.filter((e) => e.type.startsWith("delegate:")).map((e) => e.type);
}

/** A `delegate_to_agent` call for a scripted tool step. */
export function delegateCall(id: string, agent_id: string, task = "do it"): { id: string; name: string; input: unknown } {
  return { id, name: "delegate_to_agent", input: { agent_id, task } };
}
