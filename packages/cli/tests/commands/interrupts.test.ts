/**
 * Tests for `tutti-ai interrupts list` and the interrupt render
 * functions.
 *
 * The `list` command is exercised against a mocked `fetch` (the user
 * spec called this "a mock server" — mocking global fetch gives the
 * same semantics without spinning up an HTTP listener). The render
 * functions are exercised with plain fixture data.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import type { InterruptRequest } from "@tuttiai/core";

import {
  formatRelativeTime,
  renderApproved,
  renderDenied,
  renderInterruptDetail,
  renderInterruptsList,
  truncateArgs,
} from "../../src/commands/interrupts-render.js";
import { interruptsListCommand } from "../../src/commands/interrupts.js";

// Pin chalk so colour-escape assertions fire in vitest's non-TTY env.
chalk.level = 1;

/** Strip ANSI colour codes for readable assertions. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Build a fixture InterruptRequest with sensible defaults. */
function mkInterrupt(overrides: Partial<InterruptRequest> = {}): InterruptRequest {
  return {
    interrupt_id: "abcdef12-0000-0000-0000-000000000000",
    session_id: "sess-abc123",
    tool_name: "send_email",
    tool_args: { to: "alex@example.com", body: "hello" },
    requested_at: new Date("2026-04-15T10:30:00Z"),
    status: "pending",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  formatRelativeTime                                                 */
/* ------------------------------------------------------------------ */

describe("formatRelativeTime", () => {
  const now = new Date("2026-04-15T10:00:00Z");

  it("sub-60s → 's ago'", () => {
    expect(formatRelativeTime(new Date("2026-04-15T09:59:55Z"), now)).toBe("5s ago");
    expect(formatRelativeTime(new Date("2026-04-15T09:59:01Z"), now)).toBe("59s ago");
  });

  it("60s-60m → 'm ago'", () => {
    expect(formatRelativeTime(new Date("2026-04-15T09:58:00Z"), now)).toBe("2m ago");
    expect(formatRelativeTime(new Date("2026-04-15T09:01:00Z"), now)).toBe("59m ago");
  });

  it("60m-24h → 'h ago'", () => {
    expect(formatRelativeTime(new Date("2026-04-15T07:00:00Z"), now)).toBe("3h ago");
    expect(formatRelativeTime(new Date("2026-04-14T11:00:00Z"), now)).toBe("23h ago");
  });

  it("24h+ → 'd ago'", () => {
    expect(formatRelativeTime(new Date("2026-04-14T10:00:00Z"), now)).toBe("1d ago");
    expect(formatRelativeTime(new Date("2026-04-08T10:00:00Z"), now)).toBe("7d ago");
  });

  it("future timestamps render as 'now' (never negative)", () => {
    expect(formatRelativeTime(new Date("2026-04-15T10:00:05Z"), now)).toBe("now");
  });

  it("exactly 'now' → '0s ago'", () => {
    expect(formatRelativeTime(now, now)).toBe("0s ago");
  });
});

/* ------------------------------------------------------------------ */
/*  truncateArgs                                                       */
/* ------------------------------------------------------------------ */

describe("truncateArgs", () => {
  it("JSON-stringifies objects and honours the max length", () => {
    const out = truncateArgs({ to: "alex" }, 80);
    expect(out).toBe('{"to":"alex"}');
  });

  it("truncates with ellipsis past the max", () => {
    const long = { body: "x".repeat(200) };
    const out = truncateArgs(long, 30);
    expect(out.length).toBe(30);
    expect(out.endsWith("\u2026")).toBe(true);
  });

  it("falls back to String() on unstringifiable values (BigInt, circular)", () => {
    // JSON.stringify throws on BigInt by default.
    const out = truncateArgs({ big: 42n }, 80);
    // Falls back to `String({ big: 42n })` → "[object Object]".
    expect(out).toContain("object");

    // Circular ref.
    const circ: Record<string, unknown> = { a: 1 };
    circ["self"] = circ;
    const out2 = truncateArgs(circ, 80);
    expect(out2).toContain("object");
  });

  it("handles primitives", () => {
    expect(truncateArgs("hello", 80)).toBe('"hello"');
    expect(truncateArgs(42, 80)).toBe("42");
    expect(truncateArgs(null, 80)).toBe("null");
    expect(truncateArgs(true, 80)).toBe("true");
  });
});

/* ------------------------------------------------------------------ */
/*  renderInterruptsList                                               */
/* ------------------------------------------------------------------ */

describe("renderInterruptsList", () => {
  const now = new Date("2026-04-15T10:00:30Z");

  it("renders the column header and one row per interrupt", () => {
    const out = stripAnsi(
      renderInterruptsList(
        [
          mkInterrupt({
            interrupt_id: "abcdef12-0000-0000-0000-000000000000",
            session_id: "sess-alpha",
            tool_name: "send_email",
            tool_args: { to: "alex@example.com" },
            requested_at: new Date("2026-04-15T10:00:00Z"),
          }),
        ],
        now,
      ),
    );

    expect(out).toContain("ID");
    expect(out).toContain("SESSION");
    expect(out).toContain("TOOL");
    expect(out).toContain("ARGS");
    expect(out).toContain("AGE");
    expect(out).toContain("abcdef12"); // 8-char id prefix
    expect(out).toContain("sess-alpha"); // session prefix
    expect(out).toContain("send_email");
    expect(out).toContain("alex@example.com");
    expect(out).toContain("30s ago");
  });

  it("renders an empty-state message when no pending interrupts exist", () => {
    expect(stripAnsi(renderInterruptsList([]))).toBe("No pending interrupts.");
  });

  it("preserves input order — the server has already sorted oldest-first", () => {
    const old = mkInterrupt({
      interrupt_id: "11111111-aaaa",
      tool_name: "first_tool",
      requested_at: new Date("2026-04-15T09:00:00Z"),
    });
    const recent = mkInterrupt({
      interrupt_id: "22222222-bbbb",
      tool_name: "second_tool",
      requested_at: new Date("2026-04-15T09:59:00Z"),
    });
    const out = stripAnsi(renderInterruptsList([old, recent], now));
    expect(out.indexOf("first_tool")).toBeLessThan(out.indexOf("second_tool"));
  });

  it("truncates long tool_args to fit the column width", () => {
    const longArgs = { body: "x".repeat(500) };
    const out = stripAnsi(
      renderInterruptsList([mkInterrupt({ tool_args: longArgs })], now),
    );
    expect(out).toContain("\u2026"); // ellipsis marker
    expect(out).not.toContain("x".repeat(200));
  });

  it("colours tool names in cyan", () => {
    const raw = renderInterruptsList([mkInterrupt({ tool_name: "delete_user" })], now);
    expect(raw).toContain("\u001b[36mdelete_user\u001b[39m");
  });
});

/* ------------------------------------------------------------------ */
/*  renderInterruptDetail                                              */
/* ------------------------------------------------------------------ */

describe("renderInterruptDetail", () => {
  const now = new Date("2026-04-15T10:01:00Z");

  it("shows every metadata field plus pretty-printed args", () => {
    const interrupt = mkInterrupt({
      interrupt_id: "abcdef12-0000-0000-0000-000000000000",
      tool_args: { to: "alex@example.com", deeply: { nested: true } },
      requested_at: new Date("2026-04-15T10:00:00Z"),
    });
    const out = stripAnsi(renderInterruptDetail(interrupt, now));

    expect(out).toContain("abcdef12-0000-0000-0000-000000000000");
    expect(out).toContain("Session:");
    expect(out).toContain("Tool:");
    expect(out).toContain("send_email");
    expect(out).toContain("Requested:");
    expect(out).toContain("2026-04-15 10:00:00");
    expect(out).toContain("1m ago");
    expect(out).toContain("Status:");
    expect(out).toContain("pending");
    expect(out).toContain("Arguments:");
    // Pretty-printed — should have newlines inside the JSON block.
    expect(out).toContain('"to": "alex@example.com"');
    expect(out).toContain('"deeply":');
  });

  it("includes resolved_at / resolved_by / denial_reason when present", () => {
    const interrupt = mkInterrupt({
      status: "denied",
      resolved_at: new Date("2026-04-15T10:05:00Z"),
      resolved_by: "alex@example.com",
      denial_reason: "Wrong recipient",
    });
    const out = stripAnsi(renderInterruptDetail(interrupt, now));
    expect(out).toContain("Resolved:");
    expect(out).toContain("2026-04-15 10:05:00");
    expect(out).toContain("Resolved by: alex@example.com");
    expect(out).toContain("Reason:");
    expect(out).toContain("Wrong recipient");
  });

  it("colours status per state — yellow pending, green approved, red denied", () => {
    const pending = renderInterruptDetail(mkInterrupt({ status: "pending" }), now);
    const approved = renderInterruptDetail(mkInterrupt({ status: "approved" }), now);
    const denied = renderInterruptDetail(mkInterrupt({ status: "denied" }), now);
    expect(pending).toContain("\u001b[33mpending\u001b[39m");
    expect(approved).toContain("\u001b[32mapproved\u001b[39m");
    expect(denied).toContain("\u001b[31mdenied\u001b[39m");
  });
});

/* ------------------------------------------------------------------ */
/*  renderApproved / renderDenied                                      */
/* ------------------------------------------------------------------ */

describe("confirmation lines", () => {
  it("renderApproved shows the green check, 8-char id, tool, and resolver", () => {
    const out = stripAnsi(
      renderApproved(mkInterrupt({
        interrupt_id: "abcdef12-0000",
        tool_name: "send_email",
        resolved_by: "alex",
      })),
    );
    expect(out).toContain("\u2713");
    expect(out).toContain("Approved abcdef12");
    expect(out).toContain("send_email");
    expect(out).toContain("by alex");
  });

  it("renderApproved omits 'by <name>' when resolved_by is absent", () => {
    const out = stripAnsi(renderApproved(mkInterrupt({ interrupt_id: "xy01" })));
    expect(out).not.toContain(" by ");
  });

  it("renderDenied shows the red cross, id, tool, and reason when present", () => {
    const out = stripAnsi(
      renderDenied(mkInterrupt({
        interrupt_id: "abcdef12",
        tool_name: "delete_user",
        denial_reason: "Wrong account",
      })),
    );
    expect(out).toContain("\u2717");
    expect(out).toContain("Denied abcdef12");
    expect(out).toContain("delete_user");
    expect(out).toContain('"Wrong account"');
  });
});

/* ------------------------------------------------------------------ */
/*  interruptsListCommand — full command against a mocked fetch         */
/* ------------------------------------------------------------------ */

describe("interruptsListCommand (end-to-end against mock fetch)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (logSpy) logSpy.mockRestore();
  });

  function stubFetch(response: { status: number; body: unknown }): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => {
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("GETs /interrupts/pending and prints the rendered table", async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: {
        interrupts: [
          {
            interrupt_id: "abcdef12-0000",
            session_id: "sess-alpha",
            tool_name: "send_email",
            tool_args: { to: "alex@example.com" },
            requested_at: "2026-04-15T10:00:00.000Z",
            status: "pending",
          },
        ],
      },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await interruptsListCommand({ url: "http://example:9999" });

    // Request shape — right URL, bearer auth absent by default.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://example:9999/interrupts/pending");
    const req = init as { method: string; headers: Record<string, string> };
    expect(req.method).toBe("GET");
    expect(req.headers["Authorization"]).toBeUndefined();

    // Output shape — table was rendered to stdout.
    const printed = (logSpy.mock.calls[0]![0] as string) ?? "";
    const clean = stripAnsi(printed);
    expect(clean).toContain("abcdef12");
    expect(clean).toContain("send_email");
    expect(clean).toContain("alex@example.com");
  });

  it("sends the Authorization header when --api-key is provided", async () => {
    const fetchMock = stubFetch({
      status: 200,
      body: { interrupts: [] },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await interruptsListCommand({
      url: "http://example:9999",
      apiKey: "secret-token",
    });

    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers["Authorization"]).toBe("Bearer secret-token");
  });

  it("prints the empty-state message when the server returns no pending interrupts", async () => {
    stubFetch({ status: 200, body: { interrupts: [] } });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await interruptsListCommand({ url: "http://example:9999" });

    const printed = (logSpy.mock.calls[0]![0] as string) ?? "";
    expect(stripAnsi(printed)).toBe("No pending interrupts.");
  });

  it("revives requested_at from the ISO wire format so the renderer gets a Date", async () => {
    stubFetch({
      status: 200,
      body: {
        interrupts: [
          {
            interrupt_id: "fed00012",
            session_id: "s",
            tool_name: "t",
            tool_args: {},
            requested_at: "2026-04-15T10:00:00.000Z",
            status: "pending",
          },
        ],
      },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await interruptsListCommand({ url: "http://example:9999" });
    const printed = (logSpy.mock.calls[0]![0] as string) ?? "";
    // The renderer's AGE column should read a time value (e.g. '5h ago'
    // from today's perspective) — i.e. the Date.getTime() call on the
    // revived value must not throw or render NaN.
    expect(stripAnsi(printed)).toMatch(/\d+[smhd] ago|now/);
  });

  it("exits with code 1 on 401 (auth failure)", async () => {
    stubFetch({ status: 401, body: { error: "unauthorized" } });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error("process.exit(" + String(code) + ")");
      }) as typeof process.exit);

    await expect(
      interruptsListCommand({ url: "http://example:9999" }),
    ).rejects.toThrow("process.exit(1)");

    expect(errSpy.mock.calls.some((c) => String(c[0]).includes("Unauthorized"))).toBe(true);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exits with code 1 and an actionable message on 503 (no store configured)", async () => {
    stubFetch({
      status: 503,
      body: {
        error: "interrupt_store_not_configured",
        message: "...",
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error("process.exit(" + String(code) + ")");
      }) as typeof process.exit);

    await expect(
      interruptsListCommand({ url: "http://example:9999" }),
    ).rejects.toThrow("process.exit(1)");

    expect(
      errSpy.mock.calls.some((c) => String(c[0]).includes("InterruptStore")),
    ).toBe(true);

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
