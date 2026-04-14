import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

describe("rate-limit middleware", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("allows requests under the limit", async () => {
    ({ app } = await buildTestServer(
      // 3 responses for 3 requests
      [textResponse("1"), textResponse("2"), textResponse("3")],
      { rate_limit: { max: 3, timeWindow: "1 minute" } },
    ));

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/run",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { input: "hi" },
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it("returns 429 with retry_after_ms when limit is exceeded", async () => {
    ({ app } = await buildTestServer(
      [textResponse("1"), textResponse("2")],
      { rate_limit: { max: 1, timeWindow: "1 minute" } },
    ));

    // First request — allowed.
    const r1 = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    // Verify rate-limit headers are present (proves plugin loaded).
    expect(r1.headers["x-ratelimit-limit"]).toBeDefined();

    // Second request — blocked.
    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(429);
    const body = res.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(typeof body.retry_after_ms).toBe("number");
    expect(body.retry_after_ms).toBeGreaterThan(0);
  });

  it("does not rate-limit /health", async () => {
    ({ app } = await buildTestServer(
      [textResponse("unused")],
      { rate_limit: { max: 1, timeWindow: "1 minute" } },
    ));

    // Two health checks — both should pass even with max: 1.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    }
  });

  it("is disabled when rate_limit is false", async () => {
    ({ app } = await buildTestServer(
      [textResponse("1"), textResponse("2")],
      { rate_limit: false },
    ));

    // Two rapid requests — both allowed without a limiter.
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/run",
        headers: { authorization: `Bearer ${API_KEY}` },
        payload: { input: "hi" },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
