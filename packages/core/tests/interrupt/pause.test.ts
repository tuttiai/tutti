import { describe, expect, it } from "vitest";
import type { ChatMessage, ToolResultBlock } from "@tuttiai/types";

import { buildPauseCheckpoint, isPauseCheckpoint, planResume } from "../../src/interrupt/pause.js";
import type { InterruptRequest } from "../../src/interrupt/types.js";

const PAUSED_AT = new Date("2026-11-02T20:00:00Z");
const history: ChatMessage[] = [{ role: "user", content: "tidy up" }];
const assistant: ChatMessage = {
  role: "assistant",
  content: [
    { type: "text", text: "On it." },
    { type: "tool_use", id: "t-read", name: "read", input: { path: "a" } },
    { type: "tool_use", id: "t-del", name: "delete", input: { path: "a" } },
  ],
};
const readResult: ToolResultBlock = { type: "tool_result", tool_use_id: "t-read", content: "contents" };

function checkpoint(finished: ToolResultBlock[], pending: string[]) {
  return buildPauseCheckpoint({
    session_id: "s1",
    turn: 2,
    messages: [...history, assistant],
    finished,
    pending,
    usage: { input_tokens: 30, output_tokens: 12 },
    saved_at: PAUSED_AT,
  });
}

function record(status: InterruptRequest["status"], over: Partial<InterruptRequest> = {}): InterruptRequest {
  return {
    interrupt_id: `i-${status}`,
    session_id: "s1",
    tool_name: "delete",
    tool_args: { path: "a" },
    requested_at: new Date(PAUSED_AT.getTime() + 5),
    status,
    ...over,
  };
}

describe("buildPauseCheckpoint", () => {
  it("ends with the finished results and marks the turn as paused", () => {
    const cp = checkpoint([readResult], ["t-del"]);
    expect(cp.messages.at(-1)).toEqual({ role: "user", content: [readResult] });
    expect(cp.state).toMatchObject({ awaiting_tool_results: false, pending_tool_ids: ["t-del"], next_turn: 3 });
    expect(cp.tool_results).toEqual([{ content: "contents" }]);
    expect(isPauseCheckpoint(cp)).toBe(true);
  });

  it("ends on the assistant message when nothing has finished", () => {
    expect(checkpoint([], ["t-read", "t-del"]).messages.at(-1)).toBe(assistant);
  });
});

describe("isPauseCheckpoint", () => {
  it("rejects a durable end-of-turn checkpoint and one with nothing pending", () => {
    const cp = checkpoint([readResult], ["t-del"]);
    expect(isPauseCheckpoint({ ...cp, state: { ...cp.state, awaiting_tool_results: true } })).toBe(false);
    expect(isPauseCheckpoint({ ...cp, state: { ...cp.state, pending_tool_ids: [] } })).toBe(false);
  });
});

describe("planResume", () => {
  it("replays an approved call and keeps the finished result", () => {
    const plan = planResume(checkpoint([readResult], ["t-del"]), [record("approved")]);
    if (plan.kind !== "replay") throw new Error("expected a replay");
    expect(plan.turn.dispositions.get("t-read")).toEqual({ kind: "done", result: readResult });
    expect(plan.turn.dispositions.get("t-del")).toEqual({ kind: "approved" });
    expect(plan.turn.messages).toEqual(history);
    expect(plan.turn.response.content).toEqual(assistant.content);
    expect(plan.turn.usage).toEqual({ input_tokens: 30, output_tokens: 12 });
    expect(plan.turn.turn).toBe(2);
  });

  it("marks a denied call with its record", () => {
    const denied = record("denied", { denial_reason: "not today" });
    const plan = planResume(checkpoint([readResult], ["t-del"]), [denied]);
    expect(plan.kind === "replay" && plan.turn.dispositions.get("t-del")).toEqual({ kind: "denied", record: denied });
  });

  it("waits while the matched approval is still pending", () => {
    expect(planResume(checkpoint([readResult], ["t-del"]), [record("pending")])).toEqual({ kind: "wait" });
  });

  it("lets a denial win over a sibling that still waits, never running that sibling", () => {
    const cp = checkpoint([], ["t-read", "t-del"]);
    const records = [record("pending", { tool_name: "read" }), record("denied")];
    const plan = planResume(cp, records);
    expect(plan.kind === "replay" && plan.turn.dispositions.get("t-read")).toEqual({ kind: "interrupted" });
  });

  it("marks a call with no approval record as interrupted, so it never runs again", () => {
    const plan = planResume(checkpoint([], ["t-read", "t-del"]), [record("approved")]);
    expect(plan.kind === "replay" && plan.turn.dispositions.get("t-read")).toEqual({ kind: "interrupted" });
  });

  it("ignores records older than the pause, from another session, or with other arguments", () => {
    const records = [
      record("approved", { requested_at: new Date(PAUSED_AT.getTime() - 1) }),
      record("approved", { session_id: "s2" }),
      record("approved", { tool_args: { path: "b" } }),
    ];
    const plan = planResume(checkpoint([readResult], ["t-del"]), records);
    expect(plan.kind === "replay" && plan.turn.dispositions.get("t-del")).toEqual({ kind: "interrupted" });
  });

  it("matches two identical gated calls to their records oldest first", () => {
    const twin: ChatMessage = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "d1", name: "delete", input: { path: "a" } },
        { type: "tool_use", id: "d2", name: "delete", input: { path: "a" } },
      ],
    };
    const cp = { ...checkpoint([], ["d1", "d2"]), messages: [...history, twin] };
    const later = record("pending", { interrupt_id: "later", requested_at: new Date(PAUSED_AT.getTime() + 9) });
    const earlier = record("approved", { interrupt_id: "earlier" });
    expect(planResume(cp, [later, earlier])).toEqual({ kind: "wait" });
    const plan = planResume(cp, [{ ...later, status: "approved" }, earlier]);
    expect(plan.kind).toBe("replay");
  });

  it("is invalid for a checkpoint that is not a paused turn", () => {
    const cp = checkpoint([readResult], ["t-del"]);
    expect(planResume({ ...cp, state: { ...cp.state, awaiting_tool_results: true } }, [])).toEqual({ kind: "invalid" });
    expect(planResume({ ...cp, messages: history }, [])).toEqual({ kind: "invalid" });
    expect(planResume({ ...cp, state: { ...cp.state, pending_tool_ids: ["other"] } }, [])).toEqual({ kind: "invalid" });
  });
});
