import { describe, expect, it, vi } from "vitest";
import { MemoryInterruptStore, PostgresCheckpointStore, PostgresInterruptStore } from "@tuttiai/core";

import { MEMORY_APPROVALS_WARNING, buildServeStores } from "../../src/commands/serve-stores.js";

function reader(vars: Record<string, string>): (key: string) => string | undefined {
  const map = new Map(Object.entries(vars));
  return (key) => map.get(key);
}

describe("buildServeStores", () => {
  it("keeps approvals and pause checkpoints in Postgres when TUTTI_PG_URL is set", () => {
    const warn = vi.fn();
    // Nothing connects until the first query, so no database is needed here.
    const stores = buildServeStores(reader({ TUTTI_PG_URL: " postgres://u:p@db:5432/t " }), warn);
    expect(stores.durability).toBe("postgres");
    expect(stores.interruptStore).toBeInstanceOf(PostgresInterruptStore);
    expect(stores.checkpointStore).toBeInstanceOf(PostgresCheckpointStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([{}, { TUTTI_PG_URL: "   " }])("falls back to memory with one warning for %j", (vars) => {
    const warn = vi.fn();
    const stores = buildServeStores(reader(vars), warn);
    expect(stores.durability).toBe("memory");
    expect(stores.interruptStore).toBeInstanceOf(MemoryInterruptStore);
    expect(stores.checkpointStore).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(MEMORY_APPROVALS_WARNING);
  });

  it("never puts the connection string in a warning", () => {
    const warn = vi.fn();
    buildServeStores(reader({ TUTTI_PG_URL: "postgres://u:secretpw@db/t" }), warn);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secretpw");
  });

  it("gives a memory store that pauses a gated call instead of failing it", async () => {
    const { interruptStore } = buildServeStores(reader({}), vi.fn());
    const record = await interruptStore.create({ session_id: "s1", tool_name: "danger", tool_args: {} });
    expect(await interruptStore.listPending()).toEqual([record]);
  });
});
