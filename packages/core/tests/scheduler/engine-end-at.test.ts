import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { validateScore } from "../../src/score-schema.js";
import type { AgentScheduleConfig } from "@tuttiai/types";
import { createMockProvider, textResponse, simpleAgent } from "../helpers/mock-provider.js";

const T0 = Date.parse("2026-06-01T00:00:00Z");
const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

function makeEngine(store = new MemoryScheduleStore()): {
  engine: SchedulerEngine;
  store: MemoryScheduleStore;
} {
  const responses = Array.from({ length: 40 }, () => textResponse("ok"));
  const events = new EventBus();
  const runner = new AgentRunner(createMockProvider(responses), events, new InMemorySessionStore());
  return { engine: new SchedulerEngine(store, runner, events), store };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("SchedulerEngine end_at: stopping", () => {
  it("fires a run due exactly at end_at, then disables without another tick", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1m", input: "go", end_at: iso(T0 + 3 * MIN) });
    engine.start();

    await vi.advanceTimersByTimeAsync(3 * MIN);
    expect((await store.get("s"))?.run_count).toBe(3);
    expect((await store.get("s"))?.enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect((await store.get("s"))?.enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect((await store.get("s"))?.run_count).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    engine.stop();
  });

  it("stops when end_at falls between two runs", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1m", input: "go", end_at: iso(T0 + 150_000) });
    engine.start();

    await vi.advanceTimersByTimeAsync(150_001);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(2);
    expect(rec?.enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect((await store.get("s"))?.run_count).toBe(2);
    engine.stop();
  });

  it("splits an end timer longer than 24.8 days and does not fire it early", async () => {
    const { engine, store } = makeEngine();
    const end = T0 + 30 * 86_400_000;
    await engine.schedule("s", simpleAgent, { every: "1d", input: "go", end_at: iso(end) });
    engine.start();

    await vi.advanceTimersByTimeAsync(25 * 86_400_000);
    expect((await store.get("s"))?.enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * 86_400_000 + 1);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(30);
    expect(rec?.enabled).toBe(false);
    engine.stop();
  });

  it("disables a cron schedule through the end timer", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("c", simpleAgent, { cron: "0 0 29 2 5", input: "go", end_at: iso(T0 + MIN) });
    engine.start();

    await vi.advanceTimersByTimeAsync(MIN + 1);
    expect((await store.get("c"))?.enabled).toBe(false);
    expect((await store.get("c"))?.run_count).toBe(0);
    engine.stop();
  });
});

describe("SchedulerEngine end_at with max_runs", () => {
  it("stops at max_runs when it comes first, clearing the end timer too", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, {
      every: "1m", input: "go", max_runs: 2, end_at: iso(T0 + 10 * MIN),
    });
    engine.start();

    await vi.advanceTimersByTimeAsync(3 * MIN);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(2);
    expect(rec?.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    engine.stop();
  });

  it("stops at end_at when it comes first, in the same end state as max_runs", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, {
      every: "1m", input: "go", max_runs: 10, end_at: iso(T0 + 2 * MIN),
    });
    engine.start();

    await vi.advanceTimersByTimeAsync(10 * MIN);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(2);
    expect(rec?.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    engine.stop();
  });
});

describe("SchedulerEngine end_at with at and trigger()", () => {
  it("fires a past at once when end_at is still ahead", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("a", simpleAgent, { at: iso(T0 - MIN), input: "go", end_at: iso(T0 + MIN) });
    engine.start();

    await vi.advanceTimersByTimeAsync(0);
    expect((await store.get("a"))?.run_count).toBe(1);
    engine.stop();
  });

  it("fires once when end_at equals at, then disables", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("a", simpleAgent, { at: iso(T0 + MIN), input: "go", end_at: iso(T0 + MIN) });
    engine.start();

    await vi.advanceTimersByTimeAsync(MIN + 1);
    const rec = await store.get("a");
    expect(rec?.run_count).toBe(1);
    expect(rec?.enabled).toBe(false);
    engine.stop();
  });

  it("runs trigger() exactly at end_at and refuses it after", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1h", input: "go", end_at: iso(T0 + MIN) });

    vi.setSystemTime(T0 + MIN);
    await expect(engine.trigger("s")).resolves.toMatchObject({ result: "ok" });

    vi.setSystemTime(T0 + MIN + 1);
    await expect(engine.trigger("s")).rejects.toThrow("disabled or max_runs reached, or end_at passed");
    expect((await store.get("s"))?.enabled).toBe(false);
    expect((await store.get("s"))?.run_count).toBe(1);
  });
});

describe("SchedulerEngine end_at: registration", () => {
  it.each([
    ["is in the past", T0 - 1],
    ["equals now", T0],
  ])("rejects a new schedule whose end_at %s", async (_label, end) => {
    const { engine, store } = makeEngine();
    await expect(
      engine.schedule("s", simpleAgent, { every: "1m", input: "go", end_at: iso(end) }),
    ).rejects.toThrow(/end_at .* is not after the start .* Remove or extend end_at\./);
    expect(await store.get("s")).toBeNull();
  });

  it.each(["next friday", "2026-12-31", "2026-12-31T18:00:00"])(
    "rejects an end_at of %j that is not a date-time with a timezone",
    async (endAt) => {
      const { engine } = makeEngine();
      await expect(
        engine.schedule("s", simpleAgent, { every: "1m", input: "go", end_at: endAt }),
      ).rejects.toThrow(`end_at must be an ISO-8601 date-time with a timezone, got "${endAt}"`);
    },
  );

  it("rejects an end_at before at", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.schedule("a", simpleAgent, { at: iso(T0 + 2 * MIN), input: "go", end_at: iso(T0 + MIN) }),
    ).rejects.toThrow("is before at");
  });

  it("registers a reloaded schedule whose end_at has passed as finished, without throwing", async () => {
    const store = new MemoryScheduleStore();
    const config: AgentScheduleConfig = { every: "1m", input: "go", end_at: iso(T0 + MIN) };
    await makeEngine(store).engine.schedule("s", simpleAgent, config);

    vi.setSystemTime(T0 + 5 * MIN);
    const { engine } = makeEngine(store);
    await expect(engine.schedule("s", simpleAgent, config)).resolves.toBeUndefined();
    engine.start();

    expect((await store.get("s"))?.enabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await expect(engine.trigger("s")).rejects.toThrow("end_at passed");
    engine.stop();
  });

  it("keeps end_at from a validated score config through to the store", async () => {
    const schedule: AgentScheduleConfig = { every: "1m", input: "go", end_at: iso(T0 + MIN) };
    const score = { provider: { chat: () => ({}) }, agents: { r: { ...simpleAgent, schedule } } };
    validateScore(score);

    const { engine, store } = makeEngine();
    await engine.schedule("r", simpleAgent, score.agents.r.schedule);
    expect((await store.get("r"))?.config.end_at).toBe(iso(T0 + MIN));
  });
});

describe("SchedulerEngine without end_at", () => {
  it("keeps running and arms no end timer", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1m", input: "go" });
    engine.start();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(5);
    expect(rec?.enabled).toBe(true);
    engine.stop();
  });
});
