import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import { FileCheckpointStore, FileInterruptStore } from "@tuttiai/server";
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

  describe("with TUTTI_STATE_DIR", () => {
    it("keeps approvals as files that a restarted serve lists again", async () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-serve-"));
      try {
        const warn = vi.fn();
        const first = buildServeStores(reader({ TUTTI_STATE_DIR: dir }), warn);
        expect(first.durability).toBe("file");
        expect(first.interruptStore).toBeInstanceOf(FileInterruptStore);
        expect(first.checkpointStore).toBeInstanceOf(FileCheckpointStore);
        const record = await first.interruptStore.create({ session_id: "s1", tool_name: "danger", tool_args: { to: "x" } });
        const again = buildServeStores(reader({ TUTTI_STATE_DIR: dir }), warn);
        expect(await again.interruptStore.listPending()).toEqual([record]);
        expect(statSync(join(dir, "interrupts")).isDirectory()).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("prefers Postgres when both are set", () => {
      const stores = buildServeStores(reader({ TUTTI_PG_URL: "postgres://u:p@db/t", TUTTI_STATE_DIR: "/nowhere" }), vi.fn());
      expect(stores.durability).toBe("postgres");
    });

    it.each(["state", "./state", "/state\0x"])("ignores the non-absolute path %j with a warning", (value) => {
      const warn = vi.fn();
      expect(buildServeStores(reader({ TUTTI_STATE_DIR: value }), warn).durability).toBe("memory");
      expect(warn).toHaveBeenCalledWith("TUTTI_STATE_DIR must be an absolute path, such as /state; ignoring it");
    });

    it("falls back to memory when the directory cannot be written", () => {
      const dir = mkdtempSync(join(tmpdir(), "tutti-serve-"));
      try {
        writeFileSync(join(dir, "file"), "");
        const warn = vi.fn();
        const stores = buildServeStores(reader({ TUTTI_STATE_DIR: join(dir, "file") }), warn);
        expect(stores.durability).toBe("memory");
        expect(warn).toHaveBeenCalledWith("TUTTI_STATE_DIR cannot be written; keeping approvals in memory");
        expect(warn).toHaveBeenCalledWith(MEMORY_APPROVALS_WARNING);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
