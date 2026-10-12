/**
 * The session routes find a session the way a run does: from the store's
 * `get`, or else its `load`. A session a durable store kept across a restart
 * therefore answers 200, not 404.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { FileSessionStore, InMemorySessionStore } from "@tuttiai/core";
import type { Session, SessionStore } from "@tuttiai/types";

import { API_KEY, buildTestServer, textResponse } from "./helpers.js";

const AUTH = { authorization: `Bearer ${API_KEY}` };

/** A store that holds nothing in memory and finds `kept` only through `load`. */
function loadOnlyStore(): SessionStore {
  const memory = new InMemorySessionStore();
  const at = new Date("2026-10-01T00:00:00.000Z");
  const kept: Session = {
    id: "kept",
    agent_name: "test-agent",
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ],
    created_at: at,
    updated_at: at,
  };
  return {
    create: (agent_name) => memory.create(agent_name),
    get: (id) => memory.get(id),
    update: (id, messages) => memory.update(id, messages),
    load: async (id) => (id === "kept" ? kept : undefined),
  };
}

describe("session routes with a durable store", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("GET /sessions/:id finds a session only load holds", async () => {
    ({ app } = await buildTestServer([], { sessionStore: loadOnlyStore() }));

    const res = await app.inject({ method: "GET", url: "/sessions/kept", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ session_id: "kept", created_at: "2026-10-01T00:00:00.000Z" });
    expect(res.json().turns).toHaveLength(2);
  });

  it("GET /sessions/:id/turns finds a session only load holds", async () => {
    ({ app } = await buildTestServer([], { sessionStore: loadOnlyStore() }));

    const res = await app.inject({ method: "GET", url: "/sessions/kept/turns", headers: AUTH });

    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
  });

  it("still answers 404 for a session neither get nor load finds", async () => {
    ({ app } = await buildTestServer([], { sessionStore: loadOnlyStore() }));

    const res = await app.inject({ method: "GET", url: "/sessions/gone", headers: AUTH });

    expect(res.statusCode).toBe(404);
  });

  it("serves a session a FileSessionStore kept across a restart, and continues it", async () => {
    root = mkdtempSync(join(tmpdir(), "tutti-server-sessions-"));
    const dir = join(root, "sessions");
    const before = await buildTestServer([textResponse("Hello!")], { sessionStore: new FileSessionStore(dir) });
    const run = await before.app.inject({ method: "POST", url: "/run", headers: AUTH, payload: { input: "Hi" } });
    const sessionId = run.json().session_id as string;
    await before.app.close();

    ({ app } = await buildTestServer([textResponse("Again!")], { sessionStore: new FileSessionStore(dir) }));
    const res = await app.inject({ method: "GET", url: `/sessions/${sessionId}`, headers: AUTH });
    const next = await app.inject({
      method: "POST",
      url: "/run",
      headers: AUTH,
      payload: { input: "More", session_id: sessionId },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().turns).toHaveLength(2);
    expect(next.statusCode).toBe(200);
    expect(next.json().session_id).toBe(sessionId);
  });
});
