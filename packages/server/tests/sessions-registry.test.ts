import { afterEach, describe, expect, it } from "vitest";

import { defineGraph, END, TuttiRuntime } from "@tuttiai/core";
import type { AgentConfig, ChatResponse, ScoreConfig } from "@tuttiai/types";
import type { FastifyInstance } from "fastify";

import { createServer } from "../src/index.js";

function agent(name: string, model = "test-model"): AgentConfig {
  return {
    name,
    model,
    system_prompt: `You are ${name}.`,
    voices: [],
  };
}

function textResponse(text: string): ChatResponse {
  return {
    id: `r-${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 5 },
  };
}

function mockProvider(replies: ChatResponse[]): {
  chat: () => Promise<ChatResponse>;
} {
  let i = 0;
  return {
    async chat(): Promise<ChatResponse> {
      const r = replies[i++ % replies.length];
      if (!r) throw new Error("no more replies");
      return r;
    },
  };
}

const HEADERS = { authorization: "Bearer k" };

describe("GET /sessions", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns an empty list before any runs have started", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([]),
      agents: { entry: agent("entry") },
    };
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime: new TuttiRuntime(score),
      agent_name: "entry",
      api_key: "k",
    });
    const res = await app.inject({ method: "GET", url: "/sessions", headers: HEADERS });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("lists agent-mode sessions with model and turn count, newest first", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("a"), textResponse("b")]),
      default_model: "score-default",
      agents: { entry: agent("entry", "agent-model") },
    };
    const runtime = new TuttiRuntime(score);
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
    });

    // Two runs back-to-back
    const r1 = await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "first" },
    });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "second" },
    });
    expect(r2.statusCode).toBe(200);

    const list = await app.inject({ method: "GET", url: "/sessions", headers: HEADERS });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{
      id: string;
      status: string;
      turn_count: number;
      model: string;
      agent_name: string;
      started_at: string;
    }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.agent_name).toBe("entry");
      expect(row.model).toBe("agent-model");
      expect(row.status).toBe("complete");
      expect(row.turn_count).toBeGreaterThan(0);
    }
    // Newest-first ordering
    expect(rows[0]!.started_at >= rows[1]!.started_at).toBe(true);
  });

  it("surfaces graph node sessions with each node's actual model", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("a-out"), textResponse("b-out")]),
      default_model: "fallback",
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    const graph = runtime.createGraph(
      defineGraph("a")
        .node("a", agent("A", "model-a"))
        .node("b", agent("B", "model-b"))
        .edge("a", "b")
        .edge("b", END)
        .build(),
    );

    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
      graph_runner: graph,
    });

    await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "hi" },
    });

    const list = await app.inject({ method: "GET", url: "/sessions", headers: HEADERS });
    const rows = list.json() as Array<{ agent_name: string; model: string }>;
    expect(rows.map((r) => r.agent_name).sort()).toEqual(["A", "B"]);
    const byAgent = Object.fromEntries(rows.map((r) => [r.agent_name, r.model]));
    expect(byAgent.A).toBe("model-a");
    expect(byAgent.B).toBe("model-b");
  });
});

describe("GET /sessions/:id/turns", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns all turns and the count for a known session", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("hello back")]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
    });

    const run = await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "hi" },
    });
    const { session_id } = run.json() as { session_id: string };

    const turns = await app.inject({
      method: "GET",
      url: `/sessions/${session_id}/turns`,
      headers: HEADERS,
    });
    expect(turns.statusCode).toBe(200);
    const body = turns.json() as { turns: unknown[]; count: number };
    expect(body.count).toBeGreaterThan(0);
    expect(body.turns.length).toBe(body.count);
  });

  it("returns 404 for an unknown session", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([]),
      agents: { entry: agent("entry") },
    };
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime: new TuttiRuntime(score),
      agent_name: "entry",
      api_key: "k",
    });
    const res = await app.inject({
      method: "GET",
      url: "/sessions/no-such-id/turns",
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /sessions/:id/replay-from", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("truncates history at turn_index and reruns the agent", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([
        textResponse("first response"),
        textResponse("second response"),
      ]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
    });

    const run = await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "first" },
    });
    const { session_id } = run.json() as { session_id: string };

    const replay = await app.inject({
      method: "POST",
      url: `/sessions/${session_id}/replay-from`,
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { turn_index: 0, input: "do it again" },
    });
    expect(replay.statusCode).toBe(200);
    const body = replay.json() as {
      replayed_from: number;
      truncated_to: number;
      output: string;
      session_id: string;
    };
    expect(body.replayed_from).toBe(0);
    expect(body.truncated_to).toBe(0);
    expect(body.session_id).toBe(session_id);
  });

  it("rejects an out-of-range turn_index with 400", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("a")]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
    });

    const run = await app.inject({
      method: "POST",
      url: "/run",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { input: "hi" },
    });
    const { session_id } = run.json() as { session_id: string };

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session_id}/replay-from`,
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { turn_index: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_turn_index");
  });

  it("returns 404 when the session does not exist", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([]),
      agents: { entry: agent("entry") },
    };
    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime: new TuttiRuntime(score),
      agent_name: "entry",
      api_key: "k",
    });
    const res = await app.inject({
      method: "POST",
      url: "/sessions/nope/replay-from",
      headers: { ...HEADERS, "content-type": "application/json" },
      payload: { turn_index: 0, input: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });
});
