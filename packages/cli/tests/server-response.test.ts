import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectShape,
  formatIssue,
  formatIssuePath,
  formatIssues,
  parseServerResponse,
  readServerJson,
  type ResponseIssue,
  type ResponseSchema,
} from "../src/server-response.js";

const SOURCE = { endpoint: "GET /cost/runs", status: 200 };

let errSpy: ReturnType<typeof vi.spyOn>;

function printed(): string {
  return errSpy.mock.calls.map((c) => String(c[0])).join("\n");
}

/** A hand-rolled schema, so this suite does not depend on zod. */
function schemaOf(issues: ResponseIssue[]): ResponseSchema<{ ok: true }> {
  return {
    safeParse: (data: unknown) =>
      issues.length === 0 ? { success: true, data: { ok: true } } : { success: false, error: { issues } },
  };
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
  vi.restoreAllMocks();
});

describe("formatIssuePath", () => {
  it("joins keys and indexes with dots", () => {
    expect(formatIssuePath(["runs", 3, "cost_usd"])).toBe("runs.3.cost_usd");
  });

  it("prints an empty path as (root)", () => {
    expect(formatIssuePath([])).toBe("(root)");
  });

  it("removes control, ANSI, zero-width and bidi characters", () => {
    const out = formatIssuePath(["a\u001b[31mred\u0007", "b\u202e\u200bc\u009b"]);
    expect(out).toBe("a[31mred.bc");
    expect(out).not.toContain("\u001b");
  });

  it("cuts a very long path to 200 characters", () => {
    expect(formatIssuePath(["k".repeat(10_000)])).toHaveLength(200);
  });
});

describe("formatIssue", () => {
  it("names the expected and received type of a type error", () => {
    const issue = { path: ["runs", 0, "cost_usd"], code: "invalid_type", expected: "number", received: "string" };
    expect(formatIssue(issue)).toBe("runs.0.cost_usd: expected number, received string");
  });

  it("prints only the code for other issues, never a value", () => {
    const issue = { path: ["status"], code: "invalid_enum_value", received: "sk-live-PLANTED" };
    expect(formatIssue(issue)).toBe("status: invalid_enum_value");
  });

  it("falls back to the code when the type names are not plain words", () => {
    const issue = { path: ["status"], code: "invalid_type", expected: "'a' | 'b'", received: "number" };
    expect(formatIssue(issue)).toBe("status: invalid_type");
  });

  it("does not print a code that is not a plain identifier", () => {
    expect(formatIssue({ path: ["x"], code: "\u001b[2Jcustom" })).toBe("x: invalid");
  });
});

describe("formatIssues", () => {
  it("prints at most five issues, then a count of the rest", () => {
    const issues = Array.from({ length: 9 }, (_, i) => ({ path: ["runs", i], code: "custom" }));
    const lines = formatIssues(issues);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe("  - runs.0: custom");
    expect(lines[5]).toBe("  - (and 4 more)");
  });

  it("returns no lines for no issues", () => {
    expect(formatIssues([])).toEqual([]);
  });
});

describe("expectShape", () => {
  it("returns the parsed data on success", () => {
    expect(expectShape({}, schemaOf([]), SOURCE)).toEqual({ ok: true });
  });

  it("exits 1 naming the endpoint and status, with no stack trace", () => {
    const issues = [{ path: ["runs"], code: "invalid_type", expected: "array", received: "undefined" }];
    expect(() => expectShape({}, schemaOf(issues), SOURCE)).toThrow("process.exit(1)");
    expect(printed()).toContain("Error: unexpected response from GET /cost/runs (HTTP 200).");
    expect(printed()).toContain("different versions");
    expect(printed()).toContain("  - runs: expected array, received undefined");
    expect(printed()).not.toMatch(/\n\s+at /);
  });
});

describe("readServerJson", () => {
  it("parses a JSON body", async () => {
    await expect(readServerJson(new Response('{"a":1}'), "GET /x")).resolves.toEqual({ a: 1 });
  });

  it("reads an empty body as null", async () => {
    await expect(readServerJson(new Response(""), "GET /x")).resolves.toBeNull();
  });

  it("exits 1 on a 2xx body that is not JSON, without echoing it", async () => {
    await expect(readServerJson(new Response("<html>sk-live-PLANTED"), "GET /x")).rejects.toThrow("process.exit(1)");
    expect(printed()).toContain("GET /x (HTTP 200)");
    expect(printed()).toContain("response body is not valid JSON");
    expect(printed()).not.toContain("PLANTED");
  });

  it("reads a non-2xx body that is not JSON as null", async () => {
    await expect(readServerJson(new Response("Bad gateway", { status: 502 }), "GET /x")).resolves.toBeNull();
  });
});

describe("parseServerResponse", () => {
  it("reads and validates in one step", async () => {
    await expect(parseServerResponse(new Response("{}"), schemaOf([]), "GET /x")).resolves.toEqual({ ok: true });
  });

  it("reports the response's status on failure", async () => {
    const res = new Response("{}", { status: 201 });
    await expect(parseServerResponse(res, schemaOf([{ path: [], code: "custom" }]), "GET /x")).rejects.toThrow(
      "process.exit(1)",
    );
    expect(printed()).toContain("GET /x (HTTP 201)");
    expect(printed()).toContain("  - (root): custom");
  });
});
