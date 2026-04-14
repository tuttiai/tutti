import { describe, it, expect, vi, afterEach } from "vitest";
import { parseInterval, validateCron, SchedulerEngine } from "../../src/scheduler/engine.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";

// ─────────────────────────────────────────────────────────────────
// 1. Interval parsing
// ─────────────────────────────────────────────────────────────────
describe("parseInterval", () => {
  it("parses milliseconds", () => {
    expect(parseInterval("500ms")).toBe(500);
  });

  it("parses seconds", () => {
    expect(parseInterval("5s")).toBe(5_000);
  });

  it("parses minutes", () => {
    expect(parseInterval("30m")).toBe(1_800_000);
  });

  it("parses hours", () => {
    expect(parseInterval("1h")).toBe(3_600_000);
  });

  it("parses days", () => {
    expect(parseInterval("2d")).toBe(172_800_000);
  });

  it("handles decimal values", () => {
    expect(parseInterval("1.5h")).toBe(5_400_000);
  });

  it("throws on invalid format", () => {
    expect(() => parseInterval("abc")).toThrow("Invalid interval");
  });

  it("throws on missing unit", () => {
    expect(() => parseInterval("100")).toThrow("Invalid interval");
  });

  it("throws on unknown unit", () => {
    expect(() => parseInterval("5w")).toThrow("Invalid interval");
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. Cron validation
// ─────────────────────────────────────────────────────────────────
describe("validateCron", () => {
  it("accepts a valid 5-field expression", () => {
    expect(validateCron("0 9 * * *")).toBe(true);
  });

  it("accepts every-minute", () => {
    expect(validateCron("* * * * *")).toBe(true);
  });

  it("accepts step values", () => {
    expect(validateCron("*/5 * * * *")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(validateCron("")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(validateCron("not a cron")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────
// 3. SchedulerEngine — max_runs enforcement
// ─────────────────────────────────────────────────────────────────
describe("SchedulerEngine — max_runs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("disables schedule after max_runs is reached via trigger()", async () => {
    const provider = createMockProvider([
      textResponse("run-1"),
      textResponse("run-2"),
      textResponse("run-3"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    await engine.schedule("test-sched", simpleAgent, {
      every: "1h",
      input: "do work",
      max_runs: 2,
    });
    engine.start();

    // Manually trigger runs
    const run1 = await engine.trigger("test-sched");
    expect(run1.result).toBe("run-1");

    const run2 = await engine.trigger("test-sched");
    expect(run2.result).toBe("run-2");

    // Schedule should now be disabled
    const record = await store.get("test-sched");
    expect(record?.enabled).toBe(false);
    expect(record?.run_count).toBe(2);

    engine.stop();
  });

  it("allows unlimited runs when max_runs is not set", async () => {
    const provider = createMockProvider([
      textResponse("r1"),
      textResponse("r2"),
      textResponse("r3"),
      textResponse("r4"),
    ]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    await engine.schedule("unlimited", simpleAgent, {
      every: "1h",
      input: "go",
    });
    engine.start();

    await engine.trigger("unlimited");
    await engine.trigger("unlimited");
    await engine.trigger("unlimited");

    const record = await store.get("unlimited");
    expect(record?.enabled).toBe(true);
    expect(record?.run_count).toBe(3);

    engine.stop();
  });
});

// ─────────────────────────────────────────────────────────────────
// 4. SchedulerEngine — validation
// ─────────────────────────────────────────────────────────────────
describe("SchedulerEngine — validation", () => {
  it("rejects schedule with no trigger type", async () => {
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const provider = createMockProvider([]);
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    await expect(
      engine.schedule("bad", simpleAgent, { input: "hello" }),
    ).rejects.toThrow("exactly one of cron, every, or at must be set");
  });

  it("rejects invalid cron expression", async () => {
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const provider = createMockProvider([]);
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    await expect(
      engine.schedule("bad-cron", simpleAgent, {
        cron: "not valid",
        input: "hello",
      }),
    ).rejects.toThrow("invalid cron expression");
  });

  it("rejects invalid interval format", async () => {
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const provider = createMockProvider([]);
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    await expect(
      engine.schedule("bad-interval", simpleAgent, {
        every: "xyz",
        input: "hello",
      }),
    ).rejects.toThrow("Invalid interval");
  });
});

// ─────────────────────────────────────────────────────────────────
// 5. SchedulerEngine — events
// ─────────────────────────────────────────────────────────────────
describe("SchedulerEngine — events", () => {
  it("emits schedule:triggered and schedule:completed on successful run", async () => {
    const provider = createMockProvider([textResponse("done")]);
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const runner = new AgentRunner(provider, events, sessions);
    const store = new MemoryScheduleStore();
    const engine = new SchedulerEngine(store, runner, events);

    const emitted: string[] = [];
    events.onAny((e) => emitted.push(e.type));

    await engine.schedule("ev-test", simpleAgent, {
      every: "1h",
      input: "go",
    });
    engine.start();

    await engine.trigger("ev-test");

    expect(emitted).toContain("schedule:triggered");
    expect(emitted).toContain("schedule:completed");

    engine.stop();
  });
});

// ─────────────────────────────────────────────────────────────────
// 6. MemoryScheduleStore
// ─────────────────────────────────────────────────────────────────
describe("MemoryScheduleStore", () => {
  it("saves and retrieves a record", async () => {
    const store = new MemoryScheduleStore();
    await store.save({
      id: "s1",
      agent_id: "agent-a",
      config: { every: "1h", input: "hello" },
      enabled: true,
      created_at: new Date(),
      run_count: 0,
    });

    const record = await store.get("s1");
    expect(record).not.toBeNull();
    expect(record?.agent_id).toBe("agent-a");
  });

  it("returns null for unknown ID", async () => {
    const store = new MemoryScheduleStore();
    expect(await store.get("nope")).toBeNull();
  });

  it("lists records sorted by created_at", async () => {
    const store = new MemoryScheduleStore();
    await store.save({
      id: "b",
      agent_id: "x",
      config: { every: "1h", input: "hi" },
      enabled: true,
      created_at: new Date("2026-01-02"),
      run_count: 0,
    });
    await store.save({
      id: "a",
      agent_id: "x",
      config: { every: "1h", input: "hi" },
      enabled: true,
      created_at: new Date("2026-01-01"),
      run_count: 0,
    });

    const records = await store.list();
    expect(records[0]?.id).toBe("a");
    expect(records[1]?.id).toBe("b");
  });

  it("deletes a record", async () => {
    const store = new MemoryScheduleStore();
    await store.save({
      id: "del",
      agent_id: "x",
      config: { every: "1h", input: "hi" },
      enabled: true,
      created_at: new Date(),
      run_count: 0,
    });
    await store.delete("del");
    expect(await store.get("del")).toBeNull();
  });

  it("increments run_count on addRun", async () => {
    const store = new MemoryScheduleStore();
    await store.save({
      id: "cnt",
      agent_id: "x",
      config: { every: "1h", input: "hi" },
      enabled: true,
      created_at: new Date(),
      run_count: 0,
    });

    await store.addRun("cnt", {
      schedule_id: "cnt",
      agent_id: "x",
      triggered_at: new Date(),
      completed_at: new Date(),
      result: "ok",
    });

    const record = await store.get("cnt");
    expect(record?.run_count).toBe(1);
  });
});
