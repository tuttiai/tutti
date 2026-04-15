import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { SecretsManager } from "../../src/secrets.js";
import { PostgresInterruptStore } from "../../src/interrupt/postgres-store.js";

/**
 * Integration tests — require Postgres. Enable with:
 *
 *   TUTTI_PG_URL=postgres://postgres:postgres@localhost:5432/tutti_test npm test
 *
 * Uses a per-run table name so parallel runs don't collide and the
 * suite can drop its own table on teardown without touching anyone
 * else's data.
 */

const PG_URL = SecretsManager.optional("TUTTI_PG_URL");
const suite = PG_URL ? describe : describe.skip;
const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const TABLE = "tutti_interrupts_test_" + suffix;
const SESSION_A = "sess-a-" + suffix;
const SESSION_B = "sess-b-" + suffix;

suite("PostgresInterruptStore (integration)", () => {
  let store: PostgresInterruptStore;

  beforeAll(() => {
    store = new PostgresInterruptStore({
      connection_string: PG_URL!,
      table: TABLE,
    });
  });

  afterAll(async () => {
    const admin = new pg.Pool({ connectionString: PG_URL! });
    try {
      await admin.query("DROP TABLE IF EXISTS " + TABLE);
    } finally {
      await admin.end();
      await store.close();
    }
  });

  it("auto-creates the table + partial index on first use", async () => {
    const r = await store.create({
      session_id: SESSION_A,
      tool_name: "send_email",
      tool_args: { to: "a@example.com" },
    });
    expect(r.interrupt_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.session_id).toBe(SESSION_A);
    expect(r.tool_name).toBe("send_email");
    expect(r.status).toBe("pending");
    expect(r.requested_at).toBeInstanceOf(Date);
  });

  it("round-trips jsonb tool_args", async () => {
    const args = { to: "alex", cc: ["a", "b"], metadata: { urgent: true, attempt: 2 } };
    const r = await store.create({
      session_id: SESSION_A,
      tool_name: "send_email",
      tool_args: args,
    });
    const got = await store.get(r.interrupt_id);
    expect(got!.tool_args).toEqual(args);
  });

  it("get returns null for unknown ids", async () => {
    expect(await store.get("not-a-real-id-" + suffix)).toBeNull();
  });

  it("resolve transitions pending → approved and stamps resolved_at / resolved_by", async () => {
    const r = await store.create({
      session_id: SESSION_A,
      tool_name: "delete_user",
      tool_args: { id: 1 },
    });
    const resolved = await store.resolve(r.interrupt_id, "approved", {
      resolved_by: "alex@example.com",
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_at).toBeInstanceOf(Date);
    expect(resolved.resolved_by).toBe("alex@example.com");
  });

  it("resolve with 'denied' records denial_reason", async () => {
    const r = await store.create({
      session_id: SESSION_A,
      tool_name: "delete_user",
      tool_args: { id: 2 },
    });
    const resolved = await store.resolve(r.interrupt_id, "denied", {
      denial_reason: "Wrong account",
    });
    expect(resolved.status).toBe("denied");
    expect(resolved.denial_reason).toBe("Wrong account");
  });

  it("resolve is idempotent — a second call returns the existing record unchanged", async () => {
    const r = await store.create({
      session_id: SESSION_A,
      tool_name: "noop",
      tool_args: {},
    });
    const first = await store.resolve(r.interrupt_id, "approved", { resolved_by: "first" });
    const second = await store.resolve(r.interrupt_id, "denied", { denial_reason: "x" });
    expect(second.status).toBe("approved");
    expect(second.resolved_by).toBe("first");
    expect(second.denial_reason).toBeUndefined();
    expect(second.resolved_at?.getTime()).toBe(first.resolved_at?.getTime());
  });

  it("resolve throws on unknown ids", async () => {
    await expect(store.resolve("not-a-real-id-" + suffix, "approved")).rejects.toThrow(
      /unknown interrupt_id/,
    );
  });

  it("listPending returns only pending rows, oldest first", async () => {
    // Isolated session to make this assertion deterministic.
    const sess = SESSION_A + "-pending-order";
    const a = await store.create({ session_id: sess, tool_name: "a", tool_args: {} });
    await new Promise((r) => setTimeout(r, 20));
    const b = await store.create({ session_id: sess, tool_name: "b", tool_args: {} });
    await new Promise((r) => setTimeout(r, 20));
    const c = await store.create({ session_id: sess, tool_name: "c", tool_args: {} });

    await store.resolve(b.interrupt_id, "approved");

    const pending = await store.listPending(sess);
    expect(pending.map((p) => p.interrupt_id)).toEqual([a.interrupt_id, c.interrupt_id]);
  });

  it("listPending filters by session_id when provided", async () => {
    await store.create({ session_id: SESSION_A, tool_name: "x", tool_args: {} });
    await store.create({ session_id: SESSION_B, tool_name: "y", tool_args: {} });

    const onlyB = await store.listPending(SESSION_B);
    expect(onlyB.every((p) => p.session_id === SESSION_B)).toBe(true);
    expect(onlyB.some((p) => p.tool_name === "y")).toBe(true);
  });

  it("listBySession returns every status for the session, oldest first", async () => {
    const sess = SESSION_A + "-by-session";
    const a = await store.create({ session_id: sess, tool_name: "a", tool_args: {} });
    await new Promise((r) => setTimeout(r, 20));
    const b = await store.create({ session_id: sess, tool_name: "b", tool_args: {} });
    await new Promise((r) => setTimeout(r, 20));
    const c = await store.create({ session_id: sess, tool_name: "c", tool_args: {} });

    await store.resolve(a.interrupt_id, "approved");
    await store.resolve(b.interrupt_id, "denied", { denial_reason: "no" });

    const rows = await store.listBySession(sess);
    expect(rows.map((r) => r.interrupt_id)).toEqual([
      a.interrupt_id,
      b.interrupt_id,
      c.interrupt_id,
    ]);
    expect(rows.map((r) => r.status)).toEqual(["approved", "denied", "pending"]);
  });

  it("rejects invalid table identifiers in the constructor", () => {
    expect(
      () =>
        new PostgresInterruptStore({
          connection_string: "postgres://x",
          table: "drop; --",
        }),
    ).toThrow(/identifier/);
  });
});
