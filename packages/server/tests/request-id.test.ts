import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

describe("request-id middleware", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("generates a uuid when the client does not send x-request-id", async () => {
    ({ app } = await buildTestServer([textResponse("ok")]));

    const res = await app.inject({ method: "GET", url: "/health" });

    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("echoes the client-provided x-request-id", async () => {
    ({ app } = await buildTestServer([textResponse("ok")]));

    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "custom-req-123" },
    });

    expect(res.headers["x-request-id"]).toBe("custom-req-123");
  });

  it("attaches x-request-id to authenticated route responses", async () => {
    ({ app } = await buildTestServer([textResponse("Hello")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(200);
    expect(typeof res.headers["x-request-id"]).toBe("string");
  });

  it("attaches x-request-id even on 401 responses", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { input: "hi" },
    });

    expect(res.statusCode).toBe(401);
    expect(typeof res.headers["x-request-id"]).toBe("string");
  });
});
