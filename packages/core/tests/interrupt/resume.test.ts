import { describe, expect, it, vi } from "vitest";

import { MemoryCheckpointStore } from "../../src/checkpoint/memory.js";
import { MemoryInterruptStore } from "../../src/interrupt/memory-store.js";
import { buildPauseCheckpoint } from "../../src/interrupt/pause.js";
import { resumePausedRun, type ResumeDeps } from "../../src/interrupt/resume.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import type { InterruptRequest } from "../../src/interrupt/types.js";

const PAUSED_AT = new Date("2026-11-02T20:00:00Z");

async function setup(over: Partial<ResumeDeps> = {}) {
  const sessions = new InMemorySessionStore();
  const session = sessions.create("worker");
  session.updated_at = new Date(PAUSED_AT.getTime() - 1);
  const checkpoints = new MemoryCheckpointStore();
  await checkpoints.save(
    buildPauseCheckpoint({
      session_id: session.id,
      turn: 1,
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "danger_tool", input: { path: "a" } },
            { type: "tool_use", id: "b", name: "danger_tool", input: { path: "b" } },
          ],
        },
      ],
      finished: [],
      pending: ["a", "b"],
      usage: { input_tokens: 1, output_tokens: 1 },
      saved_at: PAUSED_AT,
    }),
  );
  const interrupts = new MemoryInterruptStore();
  const run = vi.fn((_agent: string, _session: string) => Promise.resolve());
  const deps: ResumeDeps = { owner: {}, sessions, checkpoints, interrupts, agents: ["worker"], run, ...over };
  return { deps, session_id: session.id, run, interrupts, checkpoints };
}

function approved(session_id: string, path: string): InterruptRequest {
  return {
    interrupt_id: `i-${path}`,
    session_id,
    tool_name: "danger_tool",
    tool_args: { path },
    requested_at: new Date(PAUSED_AT.getTime() + 1),
    status: "approved",
  };
}

describe("resumePausedRun", () => {
  it("waits while another call of the turn still needs a decision", async () => {
    const { deps, session_id, run } = await setup();
    deps.interrupts.listBySession = () =>
      Promise.resolve([approved(session_id, "a"), { ...approved(session_id, "b"), status: "pending" }]);

    await resumePausedRun(deps, approved(session_id, "a"));

    expect(run).not.toHaveBeenCalled();
  });

  it("starts one run once every call is decided", async () => {
    const { deps, session_id, run } = await setup();
    deps.interrupts.listBySession = () => Promise.resolve([approved(session_id, "a"), approved(session_id, "b")]);

    await resumePausedRun(deps, approved(session_id, "b"));

    expect(run).toHaveBeenCalledWith("worker", session_id);
  });

  it("does nothing for a checkpoint it cannot read as a paused turn", async () => {
    const { deps, session_id, run, checkpoints } = await setup();
    const cp = await checkpoints.loadLatest(session_id);
    if (!cp) throw new Error("fixture checkpoint missing");
    await checkpoints.save({ ...cp, messages: [{ role: "user", content: "go" }] });

    await resumePausedRun(deps, approved(session_id, "a"));

    expect(run).not.toHaveBeenCalled();
  });

  it("does nothing without a checkpoint store", async () => {
    const { deps, session_id, run } = await setup({ checkpoints: undefined });
    await resumePausedRun(deps, approved(session_id, "a"));
    expect(run).not.toHaveBeenCalled();
  });

  it("does not guess the agent of a lost session when the score has several", async () => {
    const { deps, session_id, run } = await setup();
    const lost: ResumeDeps = { ...deps, sessions: new InMemorySessionStore(), agents: ["worker", "other"] };
    lost.interrupts.listBySession = () => Promise.resolve([approved(session_id, "a"), approved(session_id, "b")]);

    await resumePausedRun(lost, approved(session_id, "a"));

    expect(run).not.toHaveBeenCalled();
  });

  it("never rejects when the resumed run fails", async () => {
    const run = vi.fn(() => Promise.reject(new Error("provider down")));
    const { deps, session_id } = await setup({ run });
    deps.interrupts.listBySession = () => Promise.resolve([approved(session_id, "a"), approved(session_id, "b")]);

    await expect(resumePausedRun(deps, approved(session_id, "a"))).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
