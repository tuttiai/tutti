import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

describe("POST /run", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns the agent output with usage and cost", async () => {
    ({ app } = await buildTestServer([textResponse("Hello from Tutti!")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "Hi" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.output).toBe("Hello from Tutti!");
    expect(typeof body.session_id).toBe("string");
    expect(body.turns).toBe(1);
    expect(body.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(typeof body.cost_usd).toBe("number");
    expect(body.cost_usd).toBeGreaterThan(0);
    expect(typeof body.duration_ms).toBe("number");
  });

  it("continues an existing session when session_id is provided", async () => {
    const harness = await buildTestServer([
      textResponse("First reply"),
      textResponse("Second reply"),
    ]);
    app = harness.app;

    const first = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "Hello" },
    });

    const sessionId = first.json().session_id as string;

    const second = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "Follow up", session_id: sessionId },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().session_id).toBe(sessionId);
  });

  it("returns 400 when input is missing", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when input is empty string", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 504 when the agent exceeds timeout_ms", async () => {
    // Provider that never resolves.
    const neverResolve = new Promise<never>(() => {});
    const harness = await buildTestServer([], { timeout_ms: 50 });
    app = harness.app;

    // Replace runtime.run with a never-resolving promise.
    harness.runtime.run = () => neverResolve;

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hello" },
    });

    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe("timeout");
  });

  it("returns 401 without Authorization header", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { input: "hello" },
    });

    expect(res.statusCode).toBe(401);
  });
});
