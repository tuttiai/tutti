import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TuttiError } from "@tuttiai/core";

import { FileInterruptStore, INTERRUPT_RECORD_CORRUPT } from "../../src/state/file-interrupt-store.js";

let dir: string;
const input = { session_id: "s1", tool_name: "delete_file", tool_args: { path: "/secret/plan.txt" } };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutti-interrupts-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("FileInterruptStore", () => {
  it("keeps a record across instances, so a restart lists it again", async () => {
    const created = await new FileInterruptStore(dir).create(input);
    const after = new FileInterruptStore(dir);

    expect(await after.get(created.interrupt_id)).toEqual(created);
    expect(await after.listPending()).toEqual([created]);
    expect(await after.listPending("other")).toEqual([]);
    expect(await after.listBySession("s1")).toEqual([created]);
  });

  it("writes one file per record with mode 0600", async () => {
    const created = await new FileInterruptStore(dir).create(input);
    expect(readdirSync(dir)).toEqual([`${created.interrupt_id}.json`]);
    expect(statSync(join(dir, `${created.interrupt_id}.json`)).mode & 0o777).toBe(0o600);
  });

  it("resolves once and returns the first resolution unchanged afterwards", async () => {
    const store = new FileInterruptStore(dir);
    const created = await store.create(input);

    const denied = await store.resolve(created.interrupt_id, "denied", { denial_reason: "No", resolved_by: "ops" });
    const again = await new FileInterruptStore(dir).resolve(created.interrupt_id, "approved");

    expect(denied).toMatchObject({ status: "denied", denial_reason: "No", resolved_by: "ops" });
    expect(again).toEqual(denied);
    expect(await store.listPending()).toEqual([]);
    expect(await store.listBySession("s1")).toEqual([denied]);
  });

  it("lists oldest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new FileInterruptStore(dir);
    vi.setSystemTime(new Date("2026-11-02T20:10:00Z"));
    const later = await store.create(input);
    vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
    const earlier = await store.create(input);
    expect((await store.listPending()).map((r) => r.interrupt_id)).toEqual([earlier.interrupt_id, later.interrupt_id]);
  });

  it("returns null for a missing record and rejects resolving it", async () => {
    const store = new FileInterruptStore(dir);
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await store.get(id)).toBeNull();
    await expect(store.resolve(id, "approved")).rejects.toThrow("unknown interrupt_id");
  });

  it("never touches the filesystem for an id outside the pattern", async () => {
    writeFileSync(join(dir, "..", "x.json"), "{}");
    const store = new FileInterruptStore(dir);
    expect(await store.get("../x")).toBeNull();
    expect(await store.get("x")).toBeNull();
    await expect(store.resolve("../x", "approved")).rejects.toThrow("unknown interrupt_id");
    rmSync(join(dir, "..", "x.json"), { force: true });
  });

  it.each([
    ["bad JSON", () => "{not json"],
    ["a schema failure", () => JSON.stringify({ interrupt_id: "nope" })],
    ["an id that differs from the file name", (other: string) => JSON.stringify({ ...input, interrupt_id: other, requested_at: new Date().toISOString(), status: "pending" })],
  ])("treats %s as a corrupt record without crashing", async (_label, content) => {
    const warn = vi.fn();
    const store = new FileInterruptStore(dir, warn);
    const good = await store.create(input);
    const badId = "11111111-1111-4111-8111-111111111111";
    writeFileSync(join(dir, `${badId}.json`), content(good.interrupt_id));

    expect(await store.listPending()).toEqual([good]);
    expect(warn).toHaveBeenCalledWith({ interrupt_id: badId }, expect.any(String));
    const error: unknown = await store.get(badId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TuttiError);
    expect(error).toMatchObject({ code: INTERRUPT_RECORD_CORRUPT, context: { interrupt_id: badId } });
    expect(String(error)).toContain(`interrupt ${badId} record is unreadable`);
    expect(String(error)).not.toContain(dir);
    await expect(store.resolve(badId, "approved")).rejects.toMatchObject({ code: INTERRUPT_RECORD_CORRUPT });
    expect((await store.resolve(good.interrupt_id, "approved")).status).toBe("approved");
  });

  it("never puts tool arguments in a warning", async () => {
    const warn = vi.fn();
    const store = new FileInterruptStore(dir, warn);
    writeFileSync(join(dir, "22222222-2222-4222-8222-222222222222.json"), JSON.stringify({ tool_args: "/secret/plan.txt" }));
    await store.listPending();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("clears temporary files an interrupted write left behind", () => {
    writeFileSync(join(dir, "abc.json.123.tmp"), "half");
    new FileInterruptStore(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a directory it cannot write, so the caller can fall back", () => {
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    expect(() => new FileInterruptStore(join(file, "interrupts"))).toThrow();
  });
});
