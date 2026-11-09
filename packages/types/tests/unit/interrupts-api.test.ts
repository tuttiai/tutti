import { describe, expect, it } from "vitest";

import { InterruptWireSchema, InterruptsPendingResponseSchema } from "../../src/index.js";

const ISO = "2026-11-09T19:30:00.000Z";

/** Built exactly as `toJson` in `packages/server/src/routes/interrupts.ts` builds one. */
function wire(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    interrupt_id: "int-" + i,
    session_id: "sess-1",
    tool_name: "send_email",
    tool_args: { to: "a@example.com", nested: [1, { deep: true }] },
    requested_at: ISO,
    status: "pending",
    ...extra,
  };
}

function paths(result: { error?: { issues: { path: (string | number)[] }[] } }): string[] {
  return (result.error?.issues ?? []).map((i) => i.path.join("."));
}

describe("InterruptWireSchema", () => {
  it("accepts a pending request", () => {
    const r = InterruptWireSchema.safeParse(wire(1));
    expect(r.success).toBe(true);
    expect(r.data?.tool_args).toEqual({ to: "a@example.com", nested: [1, { deep: true }] });
  });

  it("accepts a denied request with every optional field", () => {
    const denied = wire(1, { status: "denied", resolved_at: ISO, resolved_by: "ops@example.com", denial_reason: "no" });
    expect(InterruptWireSchema.safeParse(denied).success).toBe(true);
  });

  it("rejects a wrong type", () => {
    expect(paths(InterruptWireSchema.safeParse(wire(1, { session_id: 42 })))).toEqual(["session_id"]);
  });

  it("rejects a missing field", () => {
    const { requested_at: _omit, ...rest } = wire(1);
    expect(paths(InterruptWireSchema.safeParse(rest))).toEqual(["requested_at"]);
  });

  it("rejects an unknown status", () => {
    expect(paths(InterruptWireSchema.safeParse(wire(1, { status: "expired" })))).toEqual(["status"]);
  });

  it("rejects strings over the server's caps", () => {
    const long = wire(1, { resolved_by: "x".repeat(513), denial_reason: "y".repeat(4_097) });
    expect(paths(InterruptWireSchema.safeParse(long)).sort()).toEqual(["denial_reason", "resolved_by"]);
  });

  it("strips extra fields", () => {
    const r = InterruptWireSchema.safeParse(wire(1, { token: "sk-secret" }));
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("token");
  });
});

describe("InterruptsPendingResponseSchema", () => {
  it("accepts a list of requests", () => {
    const r = InterruptsPendingResponseSchema.safeParse({ interrupts: [wire(1), wire(2)] });
    expect(r.data?.interrupts).toHaveLength(2);
  });

  it("accepts an empty list", () => {
    expect(InterruptsPendingResponseSchema.safeParse({ interrupts: [] }).success).toBe(true);
  });

  it("rejects a wrong type for the list", () => {
    expect(paths(InterruptsPendingResponseSchema.safeParse({ interrupts: {} }))).toEqual(["interrupts"]);
  });

  it("rejects a missing list", () => {
    expect(paths(InterruptsPendingResponseSchema.safeParse({}))).toEqual(["interrupts"]);
  });

  it("strips extra fields", () => {
    const r = InterruptsPendingResponseSchema.safeParse({ interrupts: [], session_id: "s" });
    expect(r.data).not.toHaveProperty("session_id");
  });

  it("rejects a list over the cap", () => {
    const many = Array.from({ length: 10_001 }, (_, i) => wire(i));
    expect(paths(InterruptsPendingResponseSchema.safeParse({ interrupts: many }))).toEqual(["interrupts"]);
  });
});
