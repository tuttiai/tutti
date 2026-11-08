import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import {
  AgentNotFoundError,
  AuthenticationError,
  BudgetExceededError,
  ToolTimeoutError,
  PermissionError,
} from "@tuttiai/core";

import type { LightMyRequestResponse } from "fastify";

import { buildTestServer, API_KEY } from "./helpers.js";
import type { TestHarness } from "./helpers.js";

describe("global error handler", () => {
  // No test calls the provider: each replaces runtime.run with one that
  // rejects, so one app serves the file and is built once, in a hook.
  let harness: TestHarness;

  beforeAll(async () => {
    harness = await buildTestServer([]);
  });

  afterAll(async () => {
    await harness.app.close();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** POST /run with runtime.run forced to reject with `err`. */
  async function runThrowing(err: Error, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    harness.runtime.run = () => Promise.reject(err);
    return harness.app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}`, ...headers },
      payload: { input: "hi" },
    });
  }

  it("maps AuthenticationError to 401", async () => {
    const res = await runThrowing(new AuthenticationError("anthropic"));

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("AUTH_ERROR");
    expect(typeof res.json().request_id).toBe("string");
  });

  it("maps AgentNotFoundError to 404", async () => {
    const res = await runThrowing(new AgentNotFoundError("missing", ["assistant"]));

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("AGENT_NOT_FOUND");
  });

  it("maps ToolTimeoutError to 504", async () => {
    const res = await runThrowing(new ToolTimeoutError("slow_tool", 30_000));

    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe("TOOL_TIMEOUT");
  });

  it("maps BudgetExceededError to 402", async () => {
    const res = await runThrowing(new BudgetExceededError(100_000, 5.0, "50000 tokens"));

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("BUDGET_EXCEEDED");
  });

  it("maps PermissionError to 403", async () => {
    const res = await runThrowing(new PermissionError("filesystem", ["fs:read"], []));

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("PERMISSION_DENIED");
  });

  it("maps unknown errors to 500", async () => {
    const res = await runThrowing(new Error("something broke"));

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("INTERNAL_ERROR");
  });

  it("includes stack trace in non-production", async () => {
    const res = await runThrowing(new Error("debug me"));

    expect(res.json().stack).toBeDefined();
  });

  it("hides message and stack trace in production", async () => {
    // NODE_ENV is read per request, so stubbing it here is enough.
    vi.stubEnv("NODE_ENV", "production");

    const res = await runThrowing(new Error("secret internal details"));

    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe("Internal server error");
    expect(res.json().stack).toBeUndefined();
  });

  it("includes request_id in every error response", async () => {
    const res = await runThrowing(new Error("oops"), { "x-request-id": "trace-abc-123" });

    expect(res.json().request_id).toBe("trace-abc-123");
  });

  it("includes TuttiError context in the response", async () => {
    const res = await runThrowing(new AgentNotFoundError("ghost", ["a", "b"]));

    expect(res.json().context).toEqual({
      agent_id: "ghost",
      available: ["a", "b"],
    });
  });
});
