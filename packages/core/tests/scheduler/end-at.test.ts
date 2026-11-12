import { describe, it, expect, vi, afterEach } from "vitest";
import {
  END_AT_GRACE_MS,
  MAX_TIMER_DELAY_MS,
  armEndTimer,
  endAtState,
  hasEnded,
  isIsoDateTime,
  maxRunsReason,
  pastEndAtError,
  stopReason,
  withEndTimer,
} from "../../src/scheduler/end-at.js";
import type { ScheduleConfig, ScheduleRecord } from "../../src/scheduler/types.js";

const END = "2026-06-01T12:00:00Z";
const END_MS = Date.parse(END);

function record(config: Partial<ScheduleConfig>, run_count = 0): ScheduleRecord {
  return {
    id: "s",
    agent_id: "a",
    config: { every: "1m", input: "go", ...config },
    enabled: true,
    created_at: new Date(0),
    run_count,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("isIsoDateTime", () => {
  it.each(["2026-12-31T23:59:59Z", "2026-12-31T18:00:00+01:00", "2026-12-31T18:00:00.123Z"])(
    "accepts %s",
    (v) => expect(isIsoDateTime(v)).toBe(true),
  );

  it.each([
    "2026-12-31",
    "2026-12-31T18:00:00",
    "next friday",
    "2026-02-30T00:00:00Z",
    "",
    "2026-12-31T18:00:00Z; rm -rf /",
  ])("rejects %j", (v) => expect(isIsoDateTime(v)).toBe(false));
});

describe("endAtState", () => {
  const cfg = (c: Partial<ScheduleConfig>): ScheduleConfig => ({ every: "1m", input: "go", ...c });

  it("is open when end_at is not set", () => {
    expect(endAtState("s", cfg({}), END_MS + 1)).toBe("open");
  });

  it("is open while end_at is ahead and passed at or after it", () => {
    expect(endAtState("s", cfg({ end_at: END }), END_MS - 1)).toBe("open");
    expect(endAtState("s", cfg({ end_at: END }), END_MS)).toBe("passed");
    expect(endAtState("s", cfg({ end_at: END }), END_MS + 1)).toBe("passed");
  });

  it("throws naming end_at and quoting the value when it is not a date-time", () => {
    expect(() => endAtState("s", cfg({ end_at: "next friday" }), 0)).toThrow(
      'Schedule "s": end_at must be an ISO-8601 date-time with a timezone, got "next friday".',
    );
  });

  it("throws when end_at is before at, and allows end_at equal to at", () => {
    const at = "2026-06-01T13:00:00Z";
    expect(() => endAtState("s", { at, input: "go", end_at: END }, 0)).toThrow(
      `end_at "${END}" is before at "${at}"`,
    );
    expect(endAtState("s", { at: END, input: "go", end_at: END }, 0)).toBe("open");
  });
});

describe("pastEndAtError", () => {
  it("says the end is not after the start and how to fix it", () => {
    const err = pastEndAtError("s", { every: "1m", input: "go", end_at: END }, END_MS);
    expect(err.message).toContain(`end_at "${END}" is not after the start`);
    expect(err.message).toContain("Remove or extend end_at.");
  });
});

describe("hasEnded / stopReason / maxRunsReason", () => {
  it("treats end_at as inclusive, with a grace for late ticks", () => {
    const config: ScheduleConfig = { every: "1m", input: "go", end_at: END };
    expect(hasEnded(config, END_MS)).toBe(false);
    expect(hasEnded(config, END_MS + 5)).toBe(false);
    expect(hasEnded(config, END_MS + END_AT_GRACE_MS)).toBe(false);
    expect(hasEnded(config, END_MS + END_AT_GRACE_MS + 1)).toBe(true);
    expect(hasEnded({ every: "1m", input: "go" }, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("reports end_at before max_runs when both apply", () => {
    const r = record({ end_at: END, max_runs: 1 }, 1);
    expect(stopReason(r, END_MS + END_AT_GRACE_MS + 1)?.message).toBe("Schedule disabled: end_at reached");
    expect(stopReason(r, END_MS)?.fields).toEqual({ run_count: 1, max_runs: 1 });
  });

  it("returns undefined while neither limit applies", () => {
    expect(stopReason(record({ end_at: END, max_runs: 2 }, 1), END_MS)).toBeUndefined();
    expect(maxRunsReason(record({}, 99))).toBeUndefined();
  });
});

describe("armEndTimer", () => {
  it("fires just after endMs, never at endMs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS - 60_000);
    const onEnd = vi.fn();
    armEndTimer(END_MS, onEnd);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("splits a wait longer than the setTimeout limit into steps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const spy = vi.spyOn(globalThis, "setTimeout");
    const onEnd = vi.fn();
    const endMs = 30 * 86_400_000; // 30 days, past the 24.8-day limit
    armEndTimer(endMs, onEnd);
    expect(spy.mock.calls[0]?.[1]).toBe(MAX_TIMER_DELAY_MS);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(endMs - MAX_TIMER_DELAY_MS + 1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    for (const call of spy.mock.calls) expect(call[1]).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
  });

  it("fires from a timer, not synchronously, when endMs has passed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS + 5);
    const onEnd = vi.fn();
    armEndTimer(END_MS, onEnd);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not fire once stopped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS - 1_000);
    const onEnd = vi.fn();
    const stop = armEndTimer(END_MS, onEnd);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("withEndTimer", () => {
  it("returns the trigger stop function unchanged without end_at", () => {
    const stop = (): void => undefined;
    expect(withEndTimer({ every: "1m", input: "go" }, stop, vi.fn())).toBe(stop);
  });

  it("arms the end timer for just after end_at plus the grace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS - 1_000);
    const onEnd = vi.fn();
    withEndTimer({ every: "1m", input: "go", end_at: END }, vi.fn(), onEnd);
    await vi.advanceTimersByTimeAsync(1_000 + END_AT_GRACE_MS);
    expect(onEnd).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("stops both the trigger timer and the end timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(END_MS - 1_000);
    const stop = vi.fn();
    const onEnd = vi.fn();
    const both = withEndTimer({ every: "1m", input: "go", end_at: END }, stop, onEnd);
    both();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
