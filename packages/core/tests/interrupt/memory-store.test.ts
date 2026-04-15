import { describe, it, expect, beforeEach } from "vitest";
import { MemoryInterruptStore } from "../../src/interrupt/memory-store.js";

const SESSION = "sess-a";

describe("MemoryInterruptStore — create / get", () => {
  let store: MemoryInterruptStore;
  beforeEach(() => {
    store = new MemoryInterruptStore();
  });

  it("assigns id, requested_at, and status: 'pending' on create", async () => {
    const r = await store.create({
      session_id: SESSION,
      tool_name: "send_email",
      tool_args: { to: "alex@example.com" },
    });
    expect(r.interrupt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.session_id).toBe(SESSION);
    expect(r.tool_name).toBe("send_email");
    expect(r.tool_args).toEqual({ to: "alex@example.com" });
    expect(r.requested_at).toBeInstanceOf(Date);
    expect(r.status).toBe("pending");
    expect(r.resolved_at).toBeUndefined();
  });

  it("get returns the record by id", async () => {
    const r = await store.create({ session_id: SESSION, tool_name: "x", tool_args: {} });
    const got = await store.get(r.interrupt_id);
    expect(got).toEqual(r);
  });

  it("get returns null for unknown ids", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("assigns unique ids across concurrent creates", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const r = await store.create({ session_id: SESSION, tool_name: "t", tool_args: { i } });
      ids.add(r.interrupt_id);
    }
    expect(ids.size).toBe(50);
  });
});

describe("MemoryInterruptStore — resolve", () => {
  let store: MemoryInterruptStore;
  beforeEach(() => {
    store = new MemoryInterruptStore();
  });

  it("transitions pending → approved with resolved_at and resolved_by", async () => {
    const r = await store.create({ session_id: SESSION, tool_name: "send_email", tool_args: {} });
    const resolved = await store.resolve(r.interrupt_id, "approved", {
      resolved_by: "alex@example.com",
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_at).toBeInstanceOf(Date);
    expect(resolved.resolved_by).toBe("alex@example.com");
    expect(resolved.denial_reason).toBeUndefined();
  });

  it("transitions pending → denied and records the reason", async () => {
    const r = await store.create({ session_id: SESSION, tool_name: "delete_user", tool_args: {} });
    const resolved = await store.resolve(r.interrupt_id, "denied", {
      denial_reason: "Wrong account",
      resolved_by: "alex@example.com",
    });
    expect(resolved.status).toBe("denied");
    expect(resolved.denial_reason).toBe("Wrong account");
  });

  it("throws on unknown ids", async () => {
    await expect(store.resolve("nope", "approved")).rejects.toThrow(/unknown interrupt_id/);
  });

  it("is idempotent — a second resolve returns the existing record unchanged", async () => {
    const r = await store.create({ session_id: SESSION, tool_name: "t", tool_args: {} });
    const first = await store.resolve(r.interrupt_id, "approved", { resolved_by: "a" });
    // Second call with different fields should NOT overwrite.
    const second = await store.resolve(r.interrupt_id, "denied", {
      denial_reason: "too late",
    });
    expect(second).toEqual(first);
    expect(second.status).toBe("approved"); // unchanged
    expect(second.resolved_by).toBe("a");
    expect(second.denial_reason).toBeUndefined();
  });
});

describe("MemoryInterruptStore — listPending", () => {
  let store: MemoryInterruptStore;
  beforeEach(() => {
    store = new MemoryInterruptStore();
  });

  it("returns only pending requests, oldest first", async () => {
    const a = await store.create({ session_id: SESSION, tool_name: "a", tool_args: {} });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ session_id: SESSION, tool_name: "b", tool_args: {} });
    await new Promise((r) => setTimeout(r, 5));
    await store.create({ session_id: SESSION, tool_name: "c", tool_args: {} });

    // Approve b — only a and c should appear in listPending.
    await store.resolve(b.interrupt_id, "approved");

    const pending = await store.listPending();
    expect(pending.map((p) => p.tool_name)).toEqual(["a", "c"]); // oldest first
    expect(pending.every((p) => p.status === "pending")).toBe(true);
    expect(pending[0]!.interrupt_id).toBe(a.interrupt_id);
  });

  it("filters by session_id when provided", async () => {
    await store.create({ session_id: "sess-a", tool_name: "x", tool_args: {} });
    await store.create({ session_id: "sess-b", tool_name: "y", tool_args: {} });
    await store.create({ session_id: "sess-a", tool_name: "z", tool_args: {} });

    const onlyA = await store.listPending("sess-a");
    expect(onlyA.map((p) => p.tool_name).sort()).toEqual(["x", "z"]);
  });

  it("returns an empty array when nothing is pending", async () => {
    expect(await store.listPending()).toEqual([]);
    expect(await store.listPending("any-session")).toEqual([]);
  });
});
