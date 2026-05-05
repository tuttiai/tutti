import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

describe("GET /studio", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;
  let distDir: string;

  beforeAll(() => {
    distDir = mkdtempSync(join(tmpdir(), "studio-dist-"));
    mkdirSync(join(distDir, "assets"));
    writeFileSync(join(distDir, "index.html"), "<!doctype html><html><body>STUDIO</body></html>");
    writeFileSync(join(distDir, "assets", "app.js"), "console.log('app');");
  });

  afterAll(() => {
    rmSync(distDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("does not mount the studio route or bypass auth when studio_dist_dir is unset", async () => {
    ({ app } = await buildTestServer([textResponse("unused")]));

    // Without studio_dist_dir, /studio is just an unregistered authed
    // path — auth runs first and returns 401.
    const res = await app.inject({ method: "GET", url: "/studio" });
    expect(res.statusCode).toBe(401);
  });

  it("serves index.html at /studio without bearer auth", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({ method: "GET", url: "/studio" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("STUDIO");
  });

  it("serves real assets under /studio/assets/* without auth", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({ method: "GET", url: "/studio/assets/app.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/javascript");
    expect(res.body).toContain("console.log");
  });

  it("falls back to index.html for unknown SPA routes", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({ method: "GET", url: "/studio/agents/abc/edit" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("STUDIO");
  });

  it("does not allow path traversal out of the dist directory", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({
      method: "GET",
      url: "/studio/../../../../etc/passwd",
    });
    // Either Fastify normalises the URL itself, or the route falls back to
    // index.html — both are safe outcomes. The point is /etc/passwd is not
    // served.
    if (res.statusCode === 200) {
      expect(res.body).toContain("STUDIO");
    } else {
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects embedded `..` segments and NUL bytes without serving the target", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    for (const url of [
      "/studio/assets/../../etc/passwd",
      "/studio/assets/app.js%00.png",
    ]) {
      const res = await app.inject({ method: "GET", url });
      // Either Fastify normalises and the route doesn't match (4xx), or the
      // sanitiser rejects and the SPA fallback serves index.html — both safe.
      // The point is /etc/passwd or app.js%00 contents are never served.
      if (res.statusCode === 200) {
        expect(res.body).toContain("STUDIO");
      } else {
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
      }
    }
  });

  it("still requires auth on non-studio routes", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      payload: { input: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("still accepts valid bearer auth on /run when studio is enabled", async () => {
    ({ app } = await buildTestServer([textResponse("hi back")], {
      config: { studio_dist_dir: distDir },
    }));

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: "Bearer " + API_KEY },
      payload: { input: "hi" },
    });
    expect(res.statusCode).toBe(200);
  });
});
