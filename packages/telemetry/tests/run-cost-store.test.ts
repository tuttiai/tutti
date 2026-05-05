import { describe, it, expect } from "vitest";

import {
  InMemoryRunCostStore,
  getDailyCost,
  getMonthlyCost,
  startOfUtcDay,
  startOfUtcMonth,
} from "../src/run-cost-store.js";

describe("InMemoryRunCostStore", () => {
  it("sums only records on or after the cutoff", async () => {
    const store = new InMemoryRunCostStore();
    const t = (iso: string) => new Date(iso);

    await store.record({
      run_id: "old",
      agent_name: "a",
      started_at: t("2026-04-30T23:00:00Z"),
      cost_usd: 1.0,
      total_tokens: 100,
    });
    await store.record({
      run_id: "today1",
      agent_name: "a",
      started_at: t("2026-05-01T00:00:00Z"),
      cost_usd: 0.25,
      total_tokens: 50,
    });
    await store.record({
      run_id: "today2",
      agent_name: "a",
      started_at: t("2026-05-01T18:30:00Z"),
      cost_usd: 0.75,
      total_tokens: 50,
    });

    const total = await store.sumSince(t("2026-05-01T00:00:00Z"));
    expect(total).toBeCloseTo(1.0, 10);
  });

  it("sumSince returns 0 when no records match", async () => {
    const store = new InMemoryRunCostStore();
    expect(await store.sumSince(new Date())).toBe(0);
  });

  it("does not let post-record mutation of started_at shift the bucket", async () => {
    const store = new InMemoryRunCostStore();
    const ts = new Date("2026-05-01T12:00:00Z");
    await store.record({
      run_id: "r1",
      agent_name: "a",
      started_at: ts,
      cost_usd: 0.5,
      total_tokens: 10,
    });
    // Caller mutates their copy — must not affect what we stored.
    ts.setUTCFullYear(2099);

    const total = await store.sumSince(new Date("2026-05-01T00:00:00Z"));
    expect(total).toBeCloseTo(0.5, 10);
  });

  it("reset() drops every record", async () => {
    const store = new InMemoryRunCostStore();
    await store.record({
      run_id: "r1",
      agent_name: "a",
      started_at: new Date(),
      cost_usd: 0.5,
      total_tokens: 10,
    });
    store.reset();
    expect(await store.sumSince(new Date(0))).toBe(0);
  });
});

describe("startOfUtcDay / startOfUtcMonth", () => {
  it("startOfUtcDay floors to 00:00:00.000 UTC of the same calendar day", () => {
    const d = startOfUtcDay(new Date("2026-05-05T17:42:13.555Z"));
    expect(d.toISOString()).toBe("2026-05-05T00:00:00.000Z");
  });

  it("startOfUtcMonth returns the first of the month at 00:00 UTC", () => {
    const d = startOfUtcMonth(new Date("2026-05-05T17:42:13.555Z"));
    expect(d.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("startOfUtcMonth handles January correctly", () => {
    const d = startOfUtcMonth(new Date("2026-01-15T00:00:00Z"));
    expect(d.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("getDailyCost", () => {
  it("sums only today's runs by UTC day", async () => {
    const store = new InMemoryRunCostStore();
    const now = new Date("2026-05-05T15:00:00Z");

    await store.record({
      run_id: "yesterday",
      agent_name: "a",
      started_at: new Date("2026-05-04T23:59:59Z"),
      cost_usd: 10.0,
      total_tokens: 100,
    });
    await store.record({
      run_id: "today-early",
      agent_name: "a",
      started_at: new Date("2026-05-05T00:00:01Z"),
      cost_usd: 1.5,
      total_tokens: 100,
    });
    await store.record({
      run_id: "today-now",
      agent_name: "a",
      started_at: new Date("2026-05-05T14:00:00Z"),
      cost_usd: 2.5,
      total_tokens: 100,
    });

    const total = await getDailyCost(store, now);
    expect(total).toBeCloseTo(4.0, 10);
  });
});

describe("getMonthlyCost", () => {
  it("sums runs in the same UTC calendar month", async () => {
    const store = new InMemoryRunCostStore();
    const now = new Date("2026-05-15T12:00:00Z");

    await store.record({
      run_id: "april-end",
      agent_name: "a",
      started_at: new Date("2026-04-30T23:59:59Z"),
      cost_usd: 5.0,
      total_tokens: 100,
    });
    await store.record({
      run_id: "may-1",
      agent_name: "a",
      started_at: new Date("2026-05-01T00:00:00Z"),
      cost_usd: 1.25,
      total_tokens: 100,
    });
    await store.record({
      run_id: "may-15",
      agent_name: "a",
      started_at: new Date("2026-05-15T11:00:00Z"),
      cost_usd: 0.75,
      total_tokens: 100,
    });

    const total = await getMonthlyCost(store, now);
    expect(total).toBeCloseTo(2.0, 10);
  });
});
