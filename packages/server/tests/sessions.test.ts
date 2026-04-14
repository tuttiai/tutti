import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

describe("GET /sessions/:id", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns session history after a run", async () => {
    const harness = await buildTestServer([textResponse("Hello!")]);
    app = harness.app;

    // Run the agent to create a session.
    const runRes = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "Hi" },
    });

    const sessionId = runRes.json().session_id as string;

    const res = await app.inject({
      method: "GET",
      url: `/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.session_id).toBe(sessionId);
    expect(Array.isArray(body.turns)).toBe(true);
    // user message + assistant message = 2 turns minimum
    expect(body.turns.length).toBeGreaterThanOrEqual(2);
    expect(typeof body.created_at).toBe("string");
    expect(typeof body.updated_at).toBe("string");
  });

  it("returns 404 for an unknown session id", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "GET",
      url: "/sessions/nonexistent-id",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("session_not_found");
  });

  it("returns 401 without Authorization header", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "GET",
      url: "/sessions/some-id",
    });

    expect(res.statusCode).toBe(401);
  });
});
