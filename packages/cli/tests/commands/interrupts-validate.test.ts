/**
 * `tutti-ai interrupts list|approve|deny` against a mocked `fetch`: every
 * successful response is validated, and a malformed one ends the command
 * with exit code 1 and an error naming the endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  interruptsApproveCommand,
  interruptsDenyCommand,
  interruptsListCommand,
} from "../../src/commands/interrupts.js";
import { renderInterruptsList } from "../../src/commands/interrupts-render.js";

const ID = "44444444-4444-4444-8444-444444444444";
const ISO = "2026-11-09T19:30:00.000Z";
const OPTS = { url: "http://example:9999", apiKey: "test-key" };

let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

function stubFetch(status: number, body: unknown): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(text, { status }))));
}

function printed(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c) => String(c[0])).join("\n");
}

/** Built exactly as `toJson` in `packages/server/src/routes/interrupts.ts` builds one. */
function wire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interrupt_id: ID,
    session_id: "sess-1",
    tool_name: "send_email",
    tool_args: { to: "a@example.com" },
    requested_at: ISO,
    status: "pending",
    ...extra,
  };
}

async function expectExit(promise: Promise<void>, endpoint: string): Promise<string> {
  await expect(promise).rejects.toThrow("process.exit(1)");
  const err = printed(errSpy);
  expect(err).toContain("Error: unexpected response from " + endpoint + " (HTTP 200).");
  expect(err).not.toMatch(/\n\s+at |ZodError/);
  return err;
}

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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

describe("interrupts list", () => {
  it("renders a valid pending list", async () => {
    stubFetch(200, { interrupts: [wire()] });
    await interruptsListCommand(OPTS);
    expect(printed(logSpy)).toContain("send_email");
  });

  it("renders an empty list exactly as before", async () => {
    stubFetch(200, { interrupts: [] });
    await interruptsListCommand(OPTS);
    expect(printed(logSpy)).toBe(renderInterruptsList([]));
  });

  it("exits 1 on a wrong type", async () => {
    stubFetch(200, { interrupts: [wire({ session_id: 42 })] });
    const err = await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending");
    expect(err).toContain("  - interrupts.0.session_id: expected string, received number");
  });

  it("exits 1 on a missing field", async () => {
    stubFetch(200, {});
    const err = await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending");
    expect(err).toContain("  - interrupts: expected array, received undefined");
  });

  it("exits 1 on a list over the cap", async () => {
    stubFetch(200, { interrupts: Array.from({ length: 10_001 }, () => wire()) });
    const err = await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending");
    expect(err).toContain("  - interrupts: too_big");
  });

  it("exits 1 on an empty or non-JSON 2xx body", async () => {
    stubFetch(200, "");
    expect(await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending")).toContain(
      "  - (root): expected object, received null",
    );
    stubFetch(200, "<html>");
    expect(await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending")).toContain(
      "  - response body is not valid JSON",
    );
  });

  it("keeps the store message for a 503 whose body is not JSON", async () => {
    stubFetch(503, "Service Unavailable");
    await expect(interruptsListCommand(OPTS)).rejects.toThrow("process.exit(1)");
    expect(printed(errSpy)).toContain("no InterruptStore configured");
  });

  it("never prints a planted secret or terminal escape from an enum value", async () => {
    const hostile = "sk-live-PLANTED\u001b]8;;http://evil.test\u0007";
    stubFetch(200, { interrupts: [wire({ status: hostile, [hostile]: hostile })] });
    const err = await expectExit(interruptsListCommand(OPTS), "GET /interrupts/pending");
    expect(err).toContain("  - interrupts.0.status: invalid_enum_value");
    expect(err).not.toMatch(/PLANTED|evil|\u001b\]/);
  });
});

describe("interrupts approve|deny", () => {
  it("renders a valid approved record and ignores extra fields", async () => {
    stubFetch(200, wire({ status: "approved", resolved_at: ISO, resolved_by: "ops", secret: "sk-live-PLANTED" }));
    await interruptsApproveCommand(ID, OPTS);
    expect(printed(logSpy)).toContain("Approved 44444444 (send_email) by ops");
    expect(printed(logSpy)).not.toContain("PLANTED");
  });

  it("exits 1 on a malformed approve response, naming the endpoint without the id", async () => {
    stubFetch(200, wire({ requested_at: "yesterday" }));
    const err = await expectExit(interruptsApproveCommand(ID, OPTS), "POST /interrupts/:id/approve");
    expect(err).toContain("  - requested_at: invalid_string");
  });

  it("exits 1 on a deny response with an over-long reason", async () => {
    stubFetch(200, wire({ status: "denied", denial_reason: "x".repeat(4_097) }));
    const err = await expectExit(interruptsDenyCommand(ID, { ...OPTS, reason: "no" }), "POST /interrupts/:id/deny");
    expect(err).toContain("  - denial_reason: too_big");
    expect(err).not.toContain("xxxx");
  });
});
