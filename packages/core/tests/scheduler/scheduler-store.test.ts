import { describe, it, expect } from "vitest";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import type { ScheduleRecord } from "../../src/scheduler/types.js";

function makeRecord(id: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id,
    agent_id: "test-agent",
    config: { every: "1h", input: "go" },
    enabled: true,
    created_at: new Date("2026-01-01"),
    run_count: 0,
    ...overrides,
  };
}

describe("MemoryScheduleStore", () => {
  it("setEnabled toggles the enabled flag", async () => {
    const store = new MemoryScheduleStore();
    await store.save(makeRecord("s1"));

    await store.setEnabled("s1", false);
    expect((await store.get("s1"))?.enabled).toBe(false);

    await store.setEnabled("s1", true);
    expect((await store.get("s1"))?.enabled).toBe(true);
  });

  it("get returns a clone (mutations don't affect store)", async () => {
    const store = new MemoryScheduleStore();
    await store.save(makeRecord("s1"));

    const r1 = await store.get("s1");
    if (r1) r1.run_count = 999;

    const r2 = await store.get("s1");
    expect(r2?.run_count).toBe(0);
  });

  it("delete also clears runs", async () => {
    const store = new MemoryScheduleStore();
    await store.save(makeRecord("s1"));
    await store.addRun("s1", {
      schedule_id: "s1",
      agent_id: "test-agent",
      triggered_at: new Date(),
      result: "ok",
    });

    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
    expect(store.getRuns("s1")).toEqual([]);
  });

  it("addRun stores the run and increments run_count", async () => {
    const store = new MemoryScheduleStore();
    await store.save(makeRecord("s1"));

    await store.addRun("s1", {
      schedule_id: "s1",
      agent_id: "test-agent",
      triggered_at: new Date(),
      result: "done",
    });
    await store.addRun("s1", {
      schedule_id: "s1",
      agent_id: "test-agent",
      triggered_at: new Date(),
      error: "fail",
    });

    expect((await store.get("s1"))?.run_count).toBe(2);
    expect(store.getRuns("s1")).toHaveLength(2);
    expect(store.getRuns("s1")[0]?.result).toBe("done");
    expect(store.getRuns("s1")[1]?.error).toBe("fail");
  });

  it("list returns empty array when no records exist", async () => {
    const store = new MemoryScheduleStore();
    expect(await store.list()).toEqual([]);
  });
});
