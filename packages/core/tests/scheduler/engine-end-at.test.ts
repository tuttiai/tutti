import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { END_AT_GRACE_MS } from "../../src/scheduler/end-at.js";
import { simpleAgent } from "../helpers/mock-provider.js";
import { DAY, MIN, T0, iso, makeEngine } from "../helpers/schedule-engine.js";

const AFTER_GRACE = END_AT_GRACE_MS + 1;

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

    await vi.advanceTimersByTimeAsync(AFTER_GRACE);
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

    await vi.advanceTimersByTimeAsync(150_000 + AFTER_GRACE);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(2);
    expect(rec?.enabled).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect((await store.get("s"))?.run_count).toBe(2);
    engine.stop();
  });

  it("splits an end timer longer than 24.8 days and does not fire it early", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("s", simpleAgent, { every: "1d", input: "go", end_at: iso(T0 + 30 * DAY) });
    engine.start();

    await vi.advanceTimersByTimeAsync(25 * DAY);
    expect((await store.get("s"))?.enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(5 * DAY + AFTER_GRACE);
    const rec = await store.get("s");
    expect(rec?.run_count).toBe(30);
    expect(rec?.enabled).toBe(false);
    engine.stop();
  });

  it("disables a cron schedule through the end timer", async () => {
    const { engine, store } = makeEngine();
    await engine.schedule("c", simpleAgent, { cron: "0 0 29 2 5", input: "go", end_at: iso(T0 + MIN) });
    engine.start();

    await vi.advanceTimersByTimeAsync(MIN + AFTER_GRACE);
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
