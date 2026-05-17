import { describe, it, expect, vi, afterEach } from "vitest";

import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import type { LLMProvider } from "@tuttiai/types";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";

// Targets uncovered branches in scheduler/engine.ts that the v0.25 suite
// happened to miss: the `at` activation paths (past + future), the
// max_runs pre-tick disable, and the executeRun catch block.

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function makeEngine(provider: LLMProvider): {
  engine: SchedulerEngine;
  store: MemoryScheduleStore;
  events: EventBus;
} {
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(provider, events, sessions);
  const store = new MemoryScheduleStore();
  const engine = new SchedulerEngine(store, runner, events);
  return { engine, store, events };
}

describe("SchedulerEngine — trigger() on unknown id", () => {
  it("throws when the id has never been registered", async () => {
    const provider = createMockProvider([textResponse("never")]);
    const { engine } = makeEngine(provider);
    await expect(engine.trigger("ghost")).rejects.toThrow(/not found or not active/);
  });
});

describe("SchedulerEngine — cron activation", () => {
  it("registers a cron timer and tears it down on stop without firing it", async () => {
    vi.useFakeTimers();
    const provider = createMockProvider([textResponse("never-fires")]);
    const { engine, store } = makeEngine(provider);

    // 0 0 29 2 5 — Feb 29 on a Friday: rare enough that the cron lib
    // will not fire it within this test's frame. We're exercising the
    // activation branch + stopFn closure, not the real cron tick.
    await engine.schedule("cron-test", simpleAgent, {
      cron: "0 0 29 2 5",
      input: "go",
    });
    engine.start();

    // No tick happens — assert the record exists and is enabled, then
    // confirm stop() can tear the cron task down without throwing.
    const record = await store.get("cron-test");
    expect(record?.enabled).toBe(true);
    expect(() => engine.stop()).not.toThrow();
  });
});

describe("SchedulerEngine — `at` activation", () => {
  it("fires immediately when `at` is in the past", async () => {
    const provider = createMockProvider([textResponse("past-run")]);
    const { engine, store } = makeEngine(provider);

    const past = new Date(Date.now() - 60_000).toISOString();
    await engine.schedule("at-past", simpleAgent, {
      at: past,
      input: "go",
    });
    engine.start();

    // Activation fires onTick synchronously when delay <= 0. Yield once so
    // the awaited inner work settles before assertion.
    await new Promise((r) => setImmediate(r));

    const record = await store.get("at-past");
    expect(record?.run_count).toBe(1);

    engine.stop();
  });

  it("fires via setTimeout when `at` is in the future", async () => {
    vi.useFakeTimers();
    const provider = createMockProvider([textResponse("future-run")]);
    const { engine, store } = makeEngine(provider);

    const future = new Date(Date.now() + 60_000).toISOString();
    await engine.schedule("at-future", simpleAgent, {
      at: future,
      input: "go",
    });
    engine.start();

    // Before the timer fires, no run.
    expect((await store.get("at-future"))?.run_count).toBe(0);

    await vi.advanceTimersByTimeAsync(60_500);

    expect((await store.get("at-future"))?.run_count).toBe(1);
    engine.stop();
  });
});

describe("SchedulerEngine — max_runs pre-tick gate", () => {
  it("disables and stops when run_count already exceeds max_runs at tick", async () => {
    const provider = createMockProvider([textResponse("only-run")]);
    const { engine, store } = makeEngine(provider);

    await engine.schedule("pre-tick", simpleAgent, {
      every: "1h",
      input: "go",
      max_runs: 2,
    });
    engine.start();

    // Manually push run_count to the cap without disabling the record —
    // simulates an external mutation (eg. a second process recording a
    // run while this engine was idle). Forces the onTick pre-check.
    await store.addRun("pre-tick", {
      schedule_id: "pre-tick",
      agent_id: simpleAgent.name,
      triggered_at: new Date(),
      completed_at: new Date(),
      result: "external",
    });
    await store.addRun("pre-tick", {
      schedule_id: "pre-tick",
      agent_id: simpleAgent.name,
      triggered_at: new Date(),
      completed_at: new Date(),
      result: "external",
    });
    const before = await store.get("pre-tick");
    expect(before?.enabled).toBe(true);
    expect(before?.run_count).toBe(2);

    await expect(engine.trigger("pre-tick")).rejects.toThrow(
      /disabled or max_runs reached/,
    );

    const after = await store.get("pre-tick");
    expect(after?.enabled).toBe(false);
    engine.stop();
  });
});

describe("SchedulerEngine — executeRun error path", () => {
  it("records the error, emits schedule:error, and does not crash the timer", async () => {
    const failing: LLMProvider = {
      chat: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
      async *stream() {
        throw new Error("provider exploded");
      },
    };
    const { engine, store, events } = makeEngine(failing);

    // EventBus runs payloads through JSON.stringify for secret redaction,
    // which strips Error objects to {}. The Error's message survives only
    // on the ScheduledRun record — assert there. The event fires; we only
    // need to confirm it reached the schedule we expect.
    const seen: string[] = [];
    events.on("schedule:error", (e: { schedule_id: string }) => {
      seen.push(e.schedule_id);
    });

    await engine.schedule("boom", simpleAgent, {
      every: "1h",
      input: "go",
    });
    engine.start();

    const run = await engine.trigger("boom");
    expect(run.error).toContain("provider exploded");
    expect(run.completed_at).toBeInstanceOf(Date);
    expect(seen).toEqual(["boom"]);

    // The schedule itself stays enabled — one failure must not poison it.
    const record = await store.get("boom");
    expect(record?.enabled).toBe(true);
    engine.stop();
  });
});
