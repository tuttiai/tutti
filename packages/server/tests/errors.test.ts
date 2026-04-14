import { describe, it, expect, afterEach, vi } from "vitest";
import {
  AgentNotFoundError,
  AuthenticationError,
  BudgetExceededError,
  ToolTimeoutError,
  PermissionError,
} from "@tuttiai/core";

import { buildTestServer, API_KEY } from "./helpers.js";

describe("global error handler", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.unstubAllEnvs();
  });

  /** Helper: force runtime.run to throw a specific error. */
  async function setupThrow(err: Error): Promise<Awaited<ReturnType<typeof buildTestServer>>> {
    const harness = await buildTestServer([]);
    harness.runtime.run = () => Promise.reject(err);
    return harness;
  }

  it("maps AuthenticationError to 401", async () => {
    const harness = await setupThrow(new AuthenticationError("anthropic"));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("AUTH_ERROR");
    expect(typeof res.json().request_id).toBe("string");
  });

  it("maps AgentNotFoundError to 404", async () => {
    const harness = await setupThrow(
      new AgentNotFoundError("missing", ["assistant"]),
    );
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("AGENT_NOT_FOUND");
  });

  it("maps ToolTimeoutError to 504", async () => {
    const harness = await setupThrow(new ToolTimeoutError("slow_tool", 30_000));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe("TOOL_TIMEOUT");
  });

  it("maps BudgetExceededError to 402", async () => {
    const harness = await setupThrow(
      new BudgetExceededError(100_000, 5.0, "50000 tokens"),
    );
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("BUDGET_EXCEEDED");
  });

  it("maps PermissionError to 403", async () => {
    const harness = await setupThrow(
      new PermissionError("filesystem", ["fs:read"], []),
    );
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("PERMISSION_DENIED");
  });

  it("maps unknown errors to 500", async () => {
    const harness = await setupThrow(new Error("something broke"));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("INTERNAL_ERROR");
  });

  it("includes stack trace in non-production", async () => {
    const harness = await setupThrow(new Error("debug me"));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.json().stack).toBeDefined();
  });

  it("hides message and stack trace in production", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const harness = await setupThrow(new Error("secret internal details"));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe("Internal server error");
    expect(res.json().stack).toBeUndefined();
  });

  it("includes request_id in every error response", async () => {
    const harness = await setupThrow(new Error("oops"));
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "x-request-id": "trace-abc-123",
      },
      payload: { input: "hi" },
    });

    expect(res.json().request_id).toBe("trace-abc-123");
  });

  it("includes TuttiError context in the response", async () => {
    const harness = await setupThrow(
      new AgentNotFoundError("ghost", ["a", "b"]),
    );
    app = harness.app;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.json().context).toEqual({
      agent_id: "ghost",
      available: ["a", "b"],
    });
  });
});
