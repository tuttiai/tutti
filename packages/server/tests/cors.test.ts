import { describe, it, expect, afterEach, vi } from "vitest";

import { buildTestServer, textResponse } from "./helpers.js";

describe("CORS middleware", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    vi.unstubAllEnvs();
  });

  it("allows all origins by default (no config, no env)", async () => {
    ({ app } = await buildTestServer([textResponse("ok")]));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "https://example.com" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("restricts to configured origins", async () => {
    ({ app } = await buildTestServer([textResponse("ok")], {
      cors_origins: ["https://app.tutti.ai"],
    }));

    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "https://app.tutti.ai" },
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://app.tutti.ai",
    );

    const denied = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "https://evil.com" },
    });

    // @fastify/cors omits the header when the origin is not allowed.
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("reads TUTTI_ALLOWED_ORIGINS env var when no config is provided", async () => {
    vi.stubEnv("TUTTI_ALLOWED_ORIGINS", "https://a.com, https://b.com");

    ({ app } = await buildTestServer([textResponse("ok")]));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: { origin: "https://a.com" },
    });

    expect(res.headers["access-control-allow-origin"]).toBe("https://a.com");
  });

  it("includes Authorization and Content-Type in allowed headers", async () => {
    ({ app } = await buildTestServer([textResponse("ok")]));

    const res = await app.inject({
      method: "OPTIONS",
      url: "/health",
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
        "access-control-request-headers": "Authorization, Content-Type",
      },
    });

    const allowed = res.headers["access-control-allow-headers"];
    expect(typeof allowed).toBe("string");
    expect(String(allowed)).toContain("Authorization");
    expect(String(allowed)).toContain("Content-Type");
  });
});
