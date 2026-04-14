import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";
import { SERVER_VERSION } from "../src/config.js";

describe("GET /health", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 200 with status, version, and uptime_s", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.version).toBe(SERVER_VERSION);
    expect(typeof body.uptime_s).toBe("number");
    expect(body.uptime_s).toBeGreaterThanOrEqual(0);
  });

  it("skips authentication", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    // No Authorization header — should still succeed.
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 200 even when no api_key is configured", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], { api_key: undefined }));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 401 on authenticated routes without a bearer token", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { input: "hello" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("binds and closes on an ephemeral port", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    expect(address).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("accepts a valid Authorization header on authenticated routes", async () => {
    ({ app } = await buildTestServer([textResponse("Hello!")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hello" },
    });

    expect(res.statusCode).toBe(200);
  });
});
