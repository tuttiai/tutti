import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { AgentScheduleConfig } from "@tuttiai/types";
import { END_AT_GRACE_MS } from "../../src/scheduler/end-at.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { validateScore } from "../../src/score-schema.js";
import { simpleAgent } from "../helpers/mock-provider.js";
import { MIN, T0, iso, makeEngine } from "../helpers/schedule-engine.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

    await vi.advanceTimersByTimeAsync(MIN + END_AT_GRACE_MS + 1);
    const rec = await store.get("a");
    expect(rec?.run_count).toBe(1);
    expect(rec?.enabled).toBe(false);
    engine.stop();
  });

  it("runs a tick that arrives a few ms after end_at", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1h", input: "go", end_at: iso(T0 + MIN) });

    vi.setSystemTime(T0 + MIN + 5);
    await expect(engine.trigger("s")).resolves.toMatchObject({ result: "ok" });
    expect((await store.get("s"))?.run_count).toBe(1);
  });

  it("runs trigger() up to the grace after end_at and refuses it after", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1h", input: "go", end_at: iso(T0 + MIN) });

    vi.setSystemTime(T0 + MIN + END_AT_GRACE_MS);
    await expect(engine.trigger("s")).resolves.toMatchObject({ result: "ok" });

    vi.setSystemTime(T0 + MIN + END_AT_GRACE_MS + 1);
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
