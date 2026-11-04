import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Widening the empty start value: safe, the slot only ever holds a string a test sets.
const ids = vi.hoisted(() => ({ next: undefined as string | undefined }));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: (): string => {
      const forced = ids.next;
      ids.next = undefined;
      return forced ?? actual.randomUUID();
    },
  };
});

const { FileInterruptStore } = await import("../../src/state/file-interrupt-store.js");

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tutti-interrupt-paths-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("FileInterruptStore paths", () => {
  it.each(["../escaped", "nested/id", "not-a-uuid"])("refuses to build a path for the id %j", async (id) => {
    const dir = join(root, "interrupts");
    const store = new FileInterruptStore(dir);
    ids.next = id;
    await expect(store.create({ session_id: "s1", tool_name: "danger", tool_args: {} })).rejects.toThrow(
      "refusing an interrupt id outside the store's pattern",
    );
    expect(readdirSync(dir)).toEqual([]);
    expect(existsSync(join(root, "escaped.json"))).toBe(false);
  });

  it("still writes a record under one of its own ids", async () => {
    const store = new FileInterruptStore(root);
    const record = await store.create({ session_id: "s1", tool_name: "danger", tool_args: {} });
    expect(readdirSync(root)).toEqual([`${record.interrupt_id}.json`]);
  });
});
