import { describe, expect, it, vi } from "vitest";

import { InMemorySkillStore } from "@tuttiai/skills";
import type { Trajectory, TrajectoryToolCall } from "@tuttiai/skills";

import { EventBus } from "../../src/event-bus.js";
import { logger } from "../../src/logger.js";
import {
  DEFAULT_MAX_TOOL_CALLS_PER_RUN,
  TrajectoryObserver,
  hashToolInput,
  type TrajectoryObservationInput,
} from "../../src/skills/observer.js";

const AGENT = "router";
const RUN_ID = "01HF8K0RZTRAJ0000000000001";

function call(overrides: Partial<TrajectoryToolCall> = {}): TrajectoryToolCall {
  return {
    tool: "read_file",
    input_hash: hashToolInput({ path: "README.md" }),
    succeeded: true,
    duration_ms: 12,
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<TrajectoryObservationInput> = {},
): TrajectoryObservationInput {
  const started = new Date("2026-01-01T00:00:00Z");
  const ended = new Date(started.getTime() + 5_000); // 5s — above default min
  return {
    run_id: RUN_ID,
    agent_name: AGENT,
    started_at: started,
    ended_at: ended,
    tool_calls: [call()],
    ...overrides,
  };
}

describe("TrajectoryObserver.observe", () => {
  it("records a success trajectory when every tool call succeeded", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(baseInput());

    const trajectories = await store.listTrajectories(AGENT);
    expect(trajectories).toHaveLength(1);
    expect(trajectories[0]?.outcome).toBe("success");
    expect(trajectories[0]?.tool_calls).toHaveLength(1);
  });

  it("classifies failure when any tool call failed", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(
      baseInput({
        tool_calls: [call(), call({ tool: "write_file", succeeded: false })],
      }),
    );

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory?.outcome).toBe("failure");
  });

  it("classifies failure when the run threw, even if every tool call succeeded", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(baseInput({ error: new Error("budget exceeded") }));

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory?.outcome).toBe("failure");
  });

  it("classifies unknown when no tool calls and no error", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(baseInput({ tool_calls: [] }));

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory?.outcome).toBe("unknown");
  });

  it("does not record runs shorter than minDurationMs", async () => {
    const store = new InMemorySkillStore();
    const recordSpy = vi.spyOn(store, "recordTrajectory");
    const observer = new TrajectoryObserver({ store, minDurationMs: 1_000 });

    const started = new Date("2026-01-01T00:00:00Z");
    const ended = new Date(started.getTime() + 250); // 250ms — below floor
    await observer.observe(
      baseInput({ started_at: started, ended_at: ended }),
    );

    expect(recordSpy).not.toHaveBeenCalled();
    expect(await store.listTrajectories(AGENT)).toHaveLength(0);
  });

  it("truncates rather than dropping runs above maxToolCallsPerRun", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({
      store,
      maxToolCallsPerRun: 3,
    });

    const tool_calls: TrajectoryToolCall[] = Array.from({ length: 10 }, (_, i) =>
      call({ tool: `tool_${i}` }),
    );
    await observer.observe(baseInput({ tool_calls }));

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory).toBeDefined();
    expect(trajectory?.tool_calls).toHaveLength(3);
    expect(trajectory?.tool_calls.map((c) => c.tool)).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
    ]);
  });

  it("uses DEFAULT_MAX_TOOL_CALLS_PER_RUN when no override is supplied", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    const tool_calls = Array.from(
      { length: DEFAULT_MAX_TOOL_CALLS_PER_RUN + 5 },
      (_, i) => call({ tool: `tool_${i}` }),
    );
    await observer.observe(baseInput({ tool_calls }));

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory?.tool_calls).toHaveLength(DEFAULT_MAX_TOOL_CALLS_PER_RUN);
  });

  it("swallows store errors and logs them at warn level", async () => {
    const store = new InMemorySkillStore();
    vi.spyOn(store, "recordTrajectory").mockImplementation(async () => {
      throw new Error("disk full");
    });
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

    const observer = new TrajectoryObserver({ store });
    await expect(observer.observe(baseInput())).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]?.[1]).toContain(
      "TrajectoryObserver.observe failed",
    );

    warnSpy.mockRestore();
  });

  it("emits skill:trajectory_recorded with the post-truncation tool_count", async () => {
    const store = new InMemorySkillStore();
    const events = new EventBus();
    const observer = new TrajectoryObserver({
      store,
      events,
      maxToolCallsPerRun: 2,
    });

    const seen: Array<{ trajectory_id: string; tool_count: number }> = [];
    events.on("skill:trajectory_recorded", (e) => {
      seen.push({ trajectory_id: e.trajectory_id, tool_count: e.tool_count });
    });

    await observer.observe(
      baseInput({
        tool_calls: [call(), call({ tool: "b" }), call({ tool: "c" })],
      }),
    );

    expect(seen).toEqual([{ trajectory_id: RUN_ID, tool_count: 2 }]);
  });

  it("preserves optional user_id and final_message when provided", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(
      baseInput({ user_id: "u-42", final_message: "ok, done." }),
    );

    const [trajectory] = await store.listTrajectories(AGENT);
    expect(trajectory?.user_id).toBe("u-42");
    expect(trajectory?.final_message).toBe("ok, done.");
  });

  it("omits user_id and final_message when not provided", async () => {
    const store = new InMemorySkillStore();
    const observer = new TrajectoryObserver({ store });

    await observer.observe(baseInput());

    const [trajectory] = await store.listTrajectories(AGENT);
    const written = trajectory as Trajectory;
    expect("user_id" in written).toBe(false);
    expect("final_message" in written).toBe(false);
  });
});

describe("hashToolInput", () => {
  it("is stable under key reordering", () => {
    const a = hashToolInput({ path: "x", limit: 5 });
    const b = hashToolInput({ limit: 5, path: "x" });
    expect(a).toBe(b);
  });

  it("preserves array order semantics", () => {
    const a = hashToolInput({ items: [1, 2, 3] });
    const b = hashToolInput({ items: [3, 2, 1] });
    expect(a).not.toBe(b);
  });

  it("differs across distinct values", () => {
    expect(hashToolInput({ q: "a" })).not.toBe(hashToolInput({ q: "b" }));
  });
});
