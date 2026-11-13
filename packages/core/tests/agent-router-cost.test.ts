import { describe, it, expect, vi } from "vitest";
import { AgentRouter } from "../src/agent-router.js";
import { PRICING } from "../src/token-budget.js";
import { textResponse } from "./helpers/mock-provider.js";
import type {
  ChatRequest,
  LLMProvider,
  ScoreConfig,
  StreamChunk,
} from "@tuttiai/types";

// textResponse reports 10 input and 5 output tokens per call.
const INPUT_TOKENS = 10;
const OUTPUT_TOKENS = 5;

/** Expected cost of one textResponse call at a model's PRICING row. */
function costAt(model: string): number {
  const row = new Map(Object.entries(PRICING)).get(model);
  if (!row) throw new Error(`No PRICING row for ${model}`);
  return (INPUT_TOKENS * row.input + OUTPUT_TOKENS * row.output) / 1_000_000;
}

/** Answers at once; fails for the agent whose system prompt is "tag:bad". */
function createProvider(): LLMProvider & { chat: ReturnType<typeof vi.fn> } {
  return {
    chat: vi.fn(async (req: ChatRequest) => {
      if (req.system === "tag:bad") throw new Error("LLM exploded");
      return textResponse("ok");
    }),
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: "text", text: "stub" };
    },
  };
}

/** Parallel score with one agent per entry; undefined leaves `model` unset. */
function createScore(
  provider: LLMProvider,
  models: Record<string, string | undefined>,
  extra: Partial<ScoreConfig> = {},
): ScoreConfig {
  const agents: ScoreConfig["agents"] = {};
  for (const [id, model] of Object.entries(models)) {
    agents[id] = {
      name: id,
      system_prompt: `tag:${id}`,
      voices: [],
      ...(model === undefined ? {} : { model }),
    };
  }
  const ids = Object.keys(models);
  return { provider, agents, entry: { type: "parallel", agents: ids }, ...extra };
}

/** Runs every agent in the score once in parallel and returns the total cost. */
async function totalCost(score: ScoreConfig): Promise<number> {
  const router = new AgentRouter(score);
  const summary = await router.runParallelWithSummary(
    Object.keys(score.agents).map((agent_id) => ({ agent_id, input: "x" })),
  );
  return summary.total_cost_usd;
}

describe("runParallelWithSummary cost", () => {
  it("adds up each agent's cost at its own model's rate", async () => {
    const score = createScore(createProvider(), {
      a: "claude-sonnet-5-5",
      b: "claude-haiku-4-5",
    });

    const total = await totalCost(score);

    expect(total).toBeCloseTo(costAt("claude-sonnet-5-5") + costAt("claude-haiku-4-5"), 12);
    // What the old flat $3/$15 per million tokens gave for these two agents.
    expect(total).not.toBeCloseTo((2 * (INPUT_TOKENS * 3 + OUTPUT_TOKENS * 15)) / 1_000_000, 12);
  });

  it("costs a model with no PRICING row at $0 and still prices the others", async () => {
    const score = createScore(createProvider(), {
      known: "claude-haiku-4-5",
      unknown: "acme-unpriced-1",
    });

    const total = await totalCost(score);

    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBeCloseTo(costAt("claude-haiku-4-5"), 12);
  });

  it("prices an agent with no model at the score's default_model", async () => {
    const score = createScore(
      createProvider(),
      { a: undefined },
      { default_model: "claude-haiku-4-5" },
    );

    expect(await totalCost(score)).toBeCloseTo(costAt("claude-haiku-4-5"), 12);
  });

  it("prices an agent with no model at the model the runtime sent", async () => {
    const provider = createProvider();
    const score = createScore(provider, { a: undefined });

    const total = await totalCost(score);

    // Guards RUNTIME_DEFAULT_MODEL in agent-router.ts against drift from runtime.ts.
    const sent = provider.chat.mock.calls.map(([req]: [ChatRequest]) => req.model);
    expect(sent).toHaveLength(1);
    expect(total).toBeCloseTo(costAt(sent[0] ?? ""), 12);
  });

  it("adds no cost for an agent that fails", async () => {
    const score = createScore(createProvider(), {
      good: "claude-sonnet-5-5",
      bad: "claude-opus-4-20250514",
    });

    expect(await totalCost(score)).toBeCloseTo(costAt("claude-sonnet-5-5"), 12);
  });

  it("returns a finite 0 when no agent's model is priced", async () => {
    const score = createScore(createProvider(), {
      a: "acme-unpriced-1",
      b: "acme-unpriced-2",
    });

    const total = await totalCost(score);

    expect(typeof total).toBe("number");
    expect(Number.isFinite(total)).toBe(true);
    expect(total).toBe(0);
  });
});
