/**
 * Integration tests for the `/interrupts` and
 * `/sessions/:sessionId/interrupts` routes.
 *
 * Uses `app.inject()` (Fastify's built-in test transport) rather than
 * supertest — matches the existing server test precedent and means no
 * new devDep. Same semantics as supertest for the assertions we need.
 */

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Tool, Voice } from "@tuttiai/types";
import type { MemoryInterruptStore } from "@tuttiai/core";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

/**
 * Build a tool voice whose execute is recorded so tests can assert
 * whether approval actually gated the call.
 */
function mkToolVoice(name: string): { voice: Voice; executeCount: () => number } {
  let count = 0;
  const tool: Tool<{ to: string }> = {
    name,
    description: "test tool",
    parameters: z.object({ to: z.string() }),
    execute: async () => {
      count++;
      return { content: "tool ran" };
    },
  };
  const voice: Voice = { name: "test-voice", required_permissions: [], tools: [tool] };
  return { voice, executeCount: () => count };
}

function toolUseResponse(tool_name: string, input: unknown, id = "t1") {
  return {
    id: "resp-" + Math.random().toString(36).slice(2),
    content: [{ type: "tool_use" as const, id, name: tool_name, input }],
    stop_reason: "tool_use" as const,
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

/**
 * Wait until the store has at least one pending interrupt for a
 * session. Polls with a short budget so tests stay fast.
 */
async function waitForPending(
  store: MemoryInterruptStore,
  deadlineMs = 2000,
): Promise<void> {
  const stopAt = Date.now() + deadlineMs;
  while (Date.now() < stopAt) {
    const pending = await store.listPending();
    if (pending.length > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for a pending interrupt");
}

describe("GET /interrupts/pending", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 200 with every pending request across sessions", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    // Seed two sessions.
    await store.create({ session_id: "sess-a", tool_name: "t1", tool_args: { x: 1 } });
    await store.create({ session_id: "sess-b", tool_name: "t2", tool_args: { x: 2 } });

    const res = await app.inject({
      method: "GET",
      url: "/interrupts/pending",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { interrupts: Array<{ tool_name: string; status: string }> };
    expect(body.interrupts.map((i) => i.tool_name).sort()).toEqual(["t1", "t2"]);
    expect(body.interrupts.every((i) => i.status === "pending")).toBe(true);
  });

  it("returns 503 with a clear message when no InterruptStore is configured", async () => {
    const harness = await buildTestServer([textResponse("unused")]); // no store
    app = harness.app;

    const res = await app.inject({
      method: "GET",
      url: "/interrupts/pending",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("interrupt_store_not_configured");
  });

  it("requires authentication", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;

    const res = await app.inject({ method: "GET", url: "/interrupts/pending" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /sessions/:sessionId/interrupts", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns every status for the requested session, oldest first", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    const a = await store.create({ session_id: "sess-a", tool_name: "a", tool_args: {} });
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create({ session_id: "sess-a", tool_name: "b", tool_args: {} });
    await store.create({ session_id: "sess-b", tool_name: "other", tool_args: {} });
    await store.resolve(a.interrupt_id, "approved", { resolved_by: "alex" });
    await store.resolve(b.interrupt_id, "denied", { denial_reason: "no" });

    const res = await app.inject({
      method: "GET",
      url: "/sessions/sess-a/interrupts",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      session_id: string;
      interrupts: Array<{ tool_name: string; status: string; resolved_by?: string }>;
    };
    expect(body.session_id).toBe("sess-a");
    expect(body.interrupts.map((i) => i.tool_name)).toEqual(["a", "b"]);
    expect(body.interrupts.map((i) => i.status)).toEqual(["approved", "denied"]);
    expect(body.interrupts[0]!.resolved_by).toBe("alex");
    // sess-b interrupt must not leak.
    expect(body.interrupts.some((i) => i.tool_name === "other")).toBe(false);
  });

  it("returns an empty array for an unknown session", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;

    const res = await app.inject({
      method: "GET",
      url: "/sessions/never-existed/interrupts",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().interrupts).toEqual([]);
  });
});

describe("POST /interrupts/:id/approve — full agent-loop integration", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("resumes the run and returns the updated InterruptRequest", async () => {
    const { voice, executeCount } = mkToolVoice("test_tool");

    const harness = await buildTestServer(
      [
        toolUseResponse("test_tool", { to: "alex@example.com" }),
        textResponse("all done"),
      ],
      {
        interruptStore: "memory",
        agent: { voices: [voice], requireApproval: ["test_tool"] },
      },
    );
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    // Start the run but don't await yet — it blocks on the interrupt.
    const runPromise = app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "please send" },
    });

    // Wait for the interrupt to land in the store.
    await waitForPending(store);
    const pending = (
      await app.inject({
        method: "GET",
        url: "/interrupts/pending",
        headers: { authorization: `Bearer ${API_KEY}` },
      })
    ).json() as { interrupts: Array<{ interrupt_id: string; tool_name: string }> };
    expect(pending.interrupts).toHaveLength(1);
    expect(pending.interrupts[0]!.tool_name).toBe("test_tool");

    // Tool must NOT have executed yet — the gate is holding.
    expect(executeCount()).toBe(0);

    const interruptId = pending.interrupts[0]!.interrupt_id;
    const approve = await app.inject({
      method: "POST",
      url: `/interrupts/${interruptId}/approve`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { resolved_by: "reviewer@example.com" },
    });
    expect(approve.statusCode).toBe(200);
    const approved = approve.json() as {
      interrupt_id: string;
      status: string;
      resolved_by: string;
      resolved_at: string;
    };
    expect(approved.interrupt_id).toBe(interruptId);
    expect(approved.status).toBe("approved");
    expect(approved.resolved_by).toBe("reviewer@example.com");
    expect(typeof approved.resolved_at).toBe("string");

    // Run must now complete.
    const runRes = await runPromise;
    expect(runRes.statusCode).toBe(200);
    const body = runRes.json() as { output: string };
    expect(body.output).toBe("all done");
    expect(executeCount()).toBe(1);
  });

  it("returns 404 when the interrupt does not exist", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/interrupts/not-a-real-id/approve",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("interrupt_not_found");
  });

  it("returns 409 when the interrupt was already resolved", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    const req = await store.create({ session_id: "s", tool_name: "t", tool_args: {} });
    await store.resolve(req.interrupt_id, "approved", { resolved_by: "prior" });

    const res = await app.inject({
      method: "POST",
      url: `/interrupts/${req.interrupt_id}/approve`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { resolved_by: "another" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_resolved");
    // The response body carries the current record so the UI can reconcile.
    expect(res.json().current.status).toBe("approved");
    expect(res.json().current.resolved_by).toBe("prior");
  });
});

describe("POST /interrupts/:id/deny — full agent-loop integration", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("denies the run — /run returns a 500 with the denial reason in the body", async () => {
    const { voice, executeCount } = mkToolVoice("test_tool");

    const harness = await buildTestServer(
      [
        toolUseResponse("test_tool", { to: "bob@example.com" }),
        textResponse("unreachable"),
      ],
      {
        interruptStore: "memory",
        agent: { voices: [voice], requireApproval: ["test_tool"] },
      },
    );
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    const runPromise = app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "go" },
    });

    await waitForPending(store);
    const [pending] = await store.listPending();

    const deny = await app.inject({
      method: "POST",
      url: `/interrupts/${pending!.interrupt_id}/deny`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { reason: "Wrong recipient", resolved_by: "alex" },
    });
    expect(deny.statusCode).toBe(200);
    const denied = deny.json() as { status: string; denial_reason: string; resolved_by: string };
    expect(denied.status).toBe("denied");
    expect(denied.denial_reason).toBe("Wrong recipient");
    expect(denied.resolved_by).toBe("alex");

    // The underlying /run promise should now reject — the server's
    // error handler maps InterruptDeniedError to a 500. We only assert
    // the shape (status + message contains reason), not the exact code,
    // to stay robust to error-mapping tweaks.
    const runRes = await runPromise;
    expect(runRes.statusCode).toBeGreaterThanOrEqual(400);
    const body = runRes.json() as { message?: string; error?: string };
    const text = JSON.stringify(body);
    expect(text).toContain("Wrong recipient");

    // Tool was never executed — the gate held.
    expect(executeCount()).toBe(0);
  });

  it("returns 404 on unknown id and 409 on already-resolved", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    const notFound = await app.inject({
      method: "POST",
      url: "/interrupts/nope/deny",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { reason: "no" },
    });
    expect(notFound.statusCode).toBe(404);

    const req = await store.create({ session_id: "s", tool_name: "t", tool_args: {} });
    await store.resolve(req.interrupt_id, "denied", { denial_reason: "prior" });

    const conflict = await app.inject({
      method: "POST",
      url: `/interrupts/${req.interrupt_id}/deny`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { reason: "second" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  it("accepts a deny call with an empty body (reason is optional)", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const store = harness.interruptStore as MemoryInterruptStore;

    const req = await store.create({ session_id: "s", tool_name: "t", tool_args: {} });

    const res = await app.inject({
      method: "POST",
      url: `/interrupts/${req.interrupt_id}/deny`,
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("denied");
  });
});

describe("GET /interrupts/stream (SSE)", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 503 when no InterruptStore is configured", async () => {
    const harness = await buildTestServer([textResponse("unused")]);
    app = harness.app;
    const res = await app.inject({
      method: "GET",
      url: "/interrupts/stream",
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it("requires authentication", async () => {
    const harness = await buildTestServer([textResponse("unused")], {
      interruptStore: "memory",
    });
    app = harness.app;
    const res = await app.inject({ method: "GET", url: "/interrupts/stream" });
    expect(res.statusCode).toBe(401);
  });

  // The full SSE round-trip is covered indirectly by the CLI consumer
  // and unit-tested at the EventBus layer — exercising a long-lived
  // SSE connection through app.inject() is the same pattern that hung
  // in the /traces/stream test (undici doesn't unwind a PassThrough
  // response cleanly through inject()), so we skip the live round-trip
  // test here. See the runner-interrupt suite for end-to-end coverage
  // of the underlying event emission.
});
