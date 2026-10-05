import { describe, it, expect } from "vitest";
import { MemoryInterruptStore } from "@tuttiai/core";
import type { ScoreConfig } from "@tuttiai/types";

import type { StartAgentEnv } from "../src/start-env.js";
import { buildStartAgent, buildStartRuntime } from "../src/start-runtime.js";
import { createMockProvider } from "./helpers.js";

const BASE = { name: "assistant", model: "test-model", system_prompt: "Be brief." };

const NOTHING_SET: StartAgentEnv = {
  voices: [],
  permissions: [],
  max_turns: undefined,
  max_tool_calls: undefined,
  max_cost_usd: undefined,
  context: undefined,
  require_approval: undefined,
};

describe("buildStartAgent", () => {
  it("builds a streaming agent and leaves unset fields to the runtime", () => {
    const agent = buildStartAgent(BASE, NOTHING_SET, []);
    expect(agent).toEqual({ ...BASE, voices: [], permissions: [], streaming: true });
    expect("requireApproval" in agent).toBe(false);
  });

  it("carries the limits and the approval policy that were set", () => {
    const agent = buildStartAgent(
      BASE,
      {
        ...NOTHING_SET,
        permissions: ["network"],
        max_turns: 4,
        max_tool_calls: 9,
        max_cost_usd: 0.5,
        require_approval: ["send_*"],
      },
      [],
    );
    expect(agent.permissions).toEqual(["network"]);
    expect(agent.max_turns).toBe(4);
    expect(agent.max_tool_calls).toBe(9);
    expect(agent.budget).toEqual({ max_cost_usd: 0.5 });
    expect(agent.requireApproval).toEqual(["send_*"]);
  });

  it("carries the context settings that were set", () => {
    const agent = buildStartAgent(BASE, { ...NOTHING_SET, context: { max_tool_result_chars: 8000 } }, []);
    expect(agent.context).toEqual({ max_tool_result_chars: 8000 });
  });

  it.each([false, "all"] as const)("carries requireApproval %j", (value) => {
    const agent = buildStartAgent(BASE, { ...NOTHING_SET, require_approval: value }, []);
    expect(agent.requireApproval).toBe(value);
  });
});

describe("buildStartRuntime", () => {
  it("attaches an in-memory interrupt store", () => {
    const score: ScoreConfig = {
      provider: createMockProvider([]),
      agents: { assistant: buildStartAgent(BASE, NOTHING_SET, []) },
    };
    expect(buildStartRuntime(score).interruptStore).toBeInstanceOf(MemoryInterruptStore);
  });
});
