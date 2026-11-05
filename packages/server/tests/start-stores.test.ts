import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryInterruptStore, PostgresCheckpointStore, PostgresInterruptStore } from "@tuttiai/core";
import type { ScoreConfig } from "@tuttiai/types";

import { buildStartRuntime } from "../src/start-runtime.js";
import { readStartState } from "../src/start-state.js";
import { MEMORY_APPROVALS_WARNING, buildStartStores } from "../src/start-stores.js";
import { FileCheckpointStore } from "../src/state/file-checkpoint-store.js";
import { FileInterruptStore } from "../src/state/file-interrupt-store.js";
import { createMockProvider } from "./helpers.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tutti-start-stores-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function paths(dir: string) {
  const state = readStartState((key) => (key === "TUTTI_STATE_DIR" ? dir : undefined));
  if (!state) throw new Error("expected state paths");
  return state;
}

describe("buildStartStores", () => {
  it("chooses Postgres when TUTTI_PG_URL is set, even with a state directory", () => {
    const warn = vi.fn();
    const stores = buildStartStores(" postgres://u:p@db:5432/tutti ", paths(root), warn);
    expect(stores.durability).toBe("postgres");
    expect(stores.interrupts).toBeInstanceOf(PostgresInterruptStore);
    expect(stores.checkpoints).toBeInstanceOf(PostgresCheckpointStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it("chooses files under the state directory without Postgres", () => {
    const warn = vi.fn();
    const stores = buildStartStores("  ", paths(root), warn);
    expect(stores.durability).toBe("file");
    expect(stores.interrupts).toBeInstanceOf(FileInterruptStore);
    expect(stores.checkpoints).toBeInstanceOf(FileCheckpointStore);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to memory with one warning when neither is set", () => {
    const warn = vi.fn();
    const stores = buildStartStores(undefined, undefined, warn);
    expect(stores.durability).toBe("memory");
    expect(stores.interrupts).toBeInstanceOf(MemoryInterruptStore);
    expect(stores.checkpoints).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith({ durability: "memory" }, MEMORY_APPROVALS_WARNING);
  });

  it("falls back to memory, saying why, when the approvals directory cannot be made", () => {
    writeFileSync(join(root, "interrupts"), "not a directory");
    const warn = vi.fn();
    const stores = buildStartStores(undefined, paths(root), warn);
    expect(stores.durability).toBe("memory");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ dir: join(root, "interrupts") }), expect.any(String));
    expect(warn).toHaveBeenLastCalledWith({ durability: "memory" }, MEMORY_APPROVALS_WARNING);
  });
});

describe("buildStartRuntime with stores", () => {
  it("hands the chosen stores to the runtime", () => {
    const score: ScoreConfig = {
      provider: createMockProvider([]),
      agents: { a: { name: "a", model: "m", system_prompt: "s", voices: [] } },
    };
    const stores = buildStartStores(undefined, paths(root), vi.fn());
    expect(buildStartRuntime(score, undefined, stores).interruptStore).toBe(stores.interrupts);
  });
});
