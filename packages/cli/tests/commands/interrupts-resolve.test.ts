/**
 * `tutti-ai interrupts approve|deny` against a mocked `fetch`: the error a
 * server gives for a resolve it refuses reaches the operator.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { interruptsApproveCommand, interruptsDenyCommand } from "../../src/commands/interrupts.js";

const ID = "44444444-4444-4444-8444-444444444444";
const CORRUPT = { error: "interrupt_record_corrupt", message: `interrupt ${ID} record is unreadable` };

let errSpy: ReturnType<typeof vi.spyOn>;

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))),
  );
}

function printed(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process, "exit").mockImplementation(
    // Safe: the stub never returns, it throws so the test can see the exit code.
    ((code?: number) => {
      throw new Error("process.exit(" + String(code) + ")");
    }) as typeof process.exit,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("interrupts approve|deny when the server refuses", () => {
  it("prints the corrupt-record message on approve and exits 1", async () => {
    stubFetch(500, CORRUPT);
    await expect(interruptsApproveCommand(ID, { url: "http://example:9999" })).rejects.toThrow("process.exit(1)");
    expect(printed()).toContain(`interrupt ${ID} record is unreadable`);
    expect(printed()).not.toContain("Unexpected server response");
  });

  it("prints the corrupt-record message on deny and exits 1", async () => {
    stubFetch(500, CORRUPT);
    await expect(interruptsDenyCommand(ID, { url: "http://example:9999", reason: "no" })).rejects.toThrow("process.exit(1)");
    expect(printed()).toContain(`interrupt ${ID} record is unreadable`);
  });

  it.each([{}, { message: "" }, { message: 42 }, "oops"])("falls back to the status for the body %j", async (body) => {
    stubFetch(502, body);
    await expect(interruptsApproveCommand(ID, { url: "http://example:9999" })).rejects.toThrow("process.exit(1)");
    expect(printed()).toContain("Unexpected server response: 502");
  });

  it("keeps the not-found message for a missing record", async () => {
    stubFetch(404, { error: "interrupt_not_found", message: "gone" });
    await expect(interruptsApproveCommand(ID, { url: "http://example:9999" })).rejects.toThrow("process.exit(1)");
    expect(printed()).toContain(`Interrupt "${ID}" not found.`);
  });
});
