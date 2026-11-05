import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InterruptStore } from "@tuttiai/core";

import { lookupInterrupt } from "../src/routes/interrupt-lookup.js";
import { FileInterruptStore } from "../src/state/file-interrupt-store.js";
import { API_KEY, buildTestServer, type TestHarness } from "./helpers.js";

const CORRUPT_ID = "33333333-3333-4333-8333-333333333333";
let dir: string;
let harness: TestHarness | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutti-corrupt-"));
});

afterEach(async () => {
  await harness?.app.close();
  harness = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function serverWithCorruptRecord(): Promise<{ harness: TestHarness; goodId: string }> {
  const store = new FileInterruptStore(dir, vi.fn());
  const good = await store.create({ session_id: "s1", tool_name: "delete_file", tool_args: { path: "/private/x" } });
  writeFileSync(join(dir, `${CORRUPT_ID}.json`), '{"tool_args":{"path":"/private/secret"}');
  harness = await buildTestServer([], { interruptStore: store });
  return { harness, goodId: good.interrupt_id };
}

function post(h: TestHarness, path: string) {
  return h.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${API_KEY}` }, payload: {} });
}

describe("approval routes over a corrupt record", () => {
  it.each(["approve", "deny"])("%s answers 500 naming only the id", async (verdict) => {
    const { harness: h } = await serverWithCorruptRecord();
    const res = await post(h, `/interrupts/${CORRUPT_ID}/${verdict}`);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: "interrupt_record_corrupt",
      message: `interrupt ${CORRUPT_ID} record is unreadable`,
    });
    expect(res.payload).not.toContain("secret");
    expect(res.payload).not.toContain(dir);
  });

  it("still lists and resolves the other records", async () => {
    const { harness: h, goodId } = await serverWithCorruptRecord();
    const list = await h.app.inject({ method: "GET", url: "/interrupts/pending", headers: { authorization: `Bearer ${API_KEY}` } });
    expect(list.json<{ interrupts: { interrupt_id: string }[] }>().interrupts.map((i) => i.interrupt_id)).toEqual([goodId]);
    expect((await post(h, `/interrupts/${goodId}/approve`)).statusCode).toBe(200);
  });

  it("answers 404 for an id outside the pattern, such as ../x", async () => {
    const { harness: h } = await serverWithCorruptRecord();
    const res = await post(h, "/interrupts/..%2Fx/approve");
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "interrupt_not_found" });
  });
});

describe("lookupInterrupt", () => {
  it("passes on store errors that are not about a corrupt record", async () => {
    const store = { get: () => Promise.reject(new Error("db down")) } as unknown as InterruptStore; // Safe: only get is called.
    await expect(lookupInterrupt(store, "x")).rejects.toThrow("db down");
  });
});
