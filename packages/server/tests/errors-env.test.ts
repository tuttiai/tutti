import { afterEach, describe, expect, it, vi } from "vitest";

import { buildTestServer, API_KEY } from "./helpers.js";

type Harness = Awaited<ReturnType<typeof buildTestServer>>;

const INTERNAL_MESSAGE = "internal details for env test";

describe("error handler NODE_ENV read", () => {
  let app: Harness["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.unstubAllEnvs();
  });

  /** Send one request whose run fails with a plain Error (a 500). */
  async function failingResponse(
    nodeEnv: string | undefined,
  ): Promise<{ status: number; message: unknown; stack: unknown }> {
    vi.stubEnv("NODE_ENV", nodeEnv);
    const harness = await buildTestServer([]);
    harness.runtime.run = () => Promise.reject(new Error(INTERNAL_MESSAGE));
    app = harness.app;
    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });
    const body: { message?: unknown; stack?: unknown } = res.json();
    return { status: res.statusCode, message: body.message, stack: body.stack };
  }

  it("hides the message and stack when NODE_ENV is production", async () => {
    const res = await failingResponse("production");
    expect(res.status).toBe(500);
    expect(res.message).toBe("Internal server error");
    expect(res.stack).toBeUndefined();
  });

  it("shows the message and stack when NODE_ENV is unset", async () => {
    const res = await failingResponse(undefined);
    expect(res.status).toBe(500);
    expect(res.message).toBe(INTERNAL_MESSAGE);
    expect(res.stack).toEqual(expect.stringContaining(INTERNAL_MESSAGE));
  });

  it("shows the message and stack when NODE_ENV is empty", async () => {
    const res = await failingResponse("");
    expect(res.message).toBe(INTERNAL_MESSAGE);
    expect(res.stack).toEqual(expect.stringContaining(INTERNAL_MESSAGE));
  });

  it("shows the message and stack for another value such as development", async () => {
    const res = await failingResponse("development");
    expect(res.message).toBe(INTERNAL_MESSAGE);
    expect(res.stack).toEqual(expect.stringContaining(INTERNAL_MESSAGE));
  });

  it("treats only the exact value production as production", async () => {
    const res = await failingResponse("Production");
    expect(res.message).toBe(INTERNAL_MESSAGE);
    expect(res.stack).toEqual(expect.stringContaining(INTERNAL_MESSAGE));
  });

  it("reads NODE_ENV on each request, not when the server is built", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const harness = await buildTestServer([]);
    harness.runtime.run = () => Promise.reject(new Error(INTERNAL_MESSAGE));
    app = harness.app;
    vi.stubEnv("NODE_ENV", "production");
    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hi" },
    });
    expect(res.json()).toMatchObject({ message: "Internal server error" });
    expect(res.json()).not.toHaveProperty("stack");
  });
});
