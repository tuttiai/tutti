import { describe, expect, it } from "vitest";
import type { ChatMessage, TokenUsage } from "@tuttiai/types";

import type { Checkpoint } from "../../src/checkpoint/types.js";
import { buildPauseCheckpoint, planResume } from "../../src/interrupt/pause.js";
import type { InterruptRequest } from "../../src/interrupt/types.js";

const PAUSED_AT = new Date("2026-11-12T20:00:00Z");
const messages: ChatMessage[] = [
  { role: "user", content: "tidy up" },
  { role: "assistant", content: [{ type: "tool_use", id: "t-del", name: "delete", input: { path: "a" } }] },
];
const approved: InterruptRequest = {
  interrupt_id: "i1",
  session_id: "s1",
  tool_name: "delete",
  tool_args: { path: "a" },
  requested_at: new Date(PAUSED_AT.getTime() + 5),
  status: "approved",
};

function checkpoint(usage: TokenUsage): Checkpoint {
  return buildPauseCheckpoint({
    session_id: "s1",
    turn: 1,
    messages,
    finished: [],
    pending: ["t-del"],
    usage,
    saved_at: PAUSED_AT,
  });
}

/** A damaged checkpoint as a store reads it back, with any value in `cost_usd_used`. */
function withSavedCost(value: unknown): Checkpoint {
  const cp = checkpoint({ input_tokens: 30, output_tokens: 12 });
  const state: Record<string, unknown> = { ...cp.state, cost_usd_used: value };
  // Deliberately unsound: the stores read checkpoints back with the same cast, so any value can arrive.
  return { ...cp, state: state as Checkpoint["state"] };
}

describe("buildPauseCheckpoint and cost", () => {
  it("writes the run's spent cost as cost_usd_used", () => {
    expect(checkpoint({ input_tokens: 30, output_tokens: 12, cost_usd: 0.2 }).state.cost_usd_used).toBe(0.2);
  });

  it("writes zero for a run that has spent nothing", () => {
    expect(checkpoint({ input_tokens: 0, output_tokens: 0, cost_usd: 0 }).state.cost_usd_used).toBe(0);
  });

  it("leaves cost_usd_used out when there is no cost, as for an agent without a budget", () => {
    expect(checkpoint({ input_tokens: 30, output_tokens: 12 }).state).not.toHaveProperty("cost_usd_used");
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("never writes an invalid cost (%s)", (cost_usd) => {
    expect(checkpoint({ input_tokens: 30, output_tokens: 12, cost_usd }).state).not.toHaveProperty("cost_usd_used");
  });
});

describe("planResume and cost", () => {
  it("brings the saved cost back on the paused turn's usage", () => {
    const plan = planResume(checkpoint({ input_tokens: 30, output_tokens: 12, cost_usd: 0.2 }), [approved]);
    expect(plan.kind === "replay" ? plan.turn.usage : undefined).toEqual({ input_tokens: 30, output_tokens: 12, cost_usd: 0.2 });
  });

  it("brings back a saved cost of zero", () => {
    const plan = planResume(checkpoint({ input_tokens: 0, output_tokens: 0, cost_usd: 0 }), [approved]);
    expect(plan.kind === "replay" ? plan.turn.usage.cost_usd : undefined).toBe(0);
  });

  it("replays a checkpoint saved before cost was kept, with no cost on its usage", () => {
    const plan = planResume(checkpoint({ input_tokens: 30, output_tokens: 12 }), [approved]);
    expect(plan.kind).toBe("replay");
    expect(plan.kind === "replay" ? plan.turn.usage : undefined).toEqual({ input_tokens: 30, output_tokens: 12 });
  });

  // JSON stores turn NaN and Infinity into null, so null stands for both as read back.
  it.each([
    ["a negative number", -1],
    ["null (NaN or Infinity after JSON)", null],
    ["a string", "0.1"],
    ["an object", { usd: 0.1 }],
  ])("refuses a saved cost that is %s", (_label, value) => {
    expect(planResume(withSavedCost(value), [approved])).toEqual({ kind: "invalid" });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("refuses a saved cost of %s held in memory", (value) => {
    const cp = checkpoint({ input_tokens: 30, output_tokens: 12 });
    expect(planResume({ ...cp, state: { ...cp.state, cost_usd_used: value } }, [approved])).toEqual({ kind: "invalid" });
  });
});
