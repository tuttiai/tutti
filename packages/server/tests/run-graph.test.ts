import { afterEach, describe, expect, it } from "vitest";

import { defineGraph, END, TuttiRuntime } from "@tuttiai/core";
import type { AgentConfig, ChatResponse, ScoreConfig } from "@tuttiai/types";

import { createServer } from "../src/index.js";
import type { FastifyInstance } from "fastify";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
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

describe("POST /run with graph_runner", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("delegates to graph.run and returns final_output as `output`", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([
        textResponse("a-out"),
        textResponse("b-out"),
        textResponse("c-out"),
      ]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    const graph = runtime.createGraph(
      defineGraph("a")
        .node("a", agent("A"))
        .node("b", agent("B"))
        .node("c", agent("C"))
        .edge("a", "b")
        .edge("b", "c")
        .edge("c", END)
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

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      payload: { input: "go" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      output: string;
      session_id: string;
      turns: number;
      duration_ms: number;
    };
    expect(body.output).toBe("c-out");
    expect(typeof body.session_id).toBe("string");
    expect(body.session_id.length).toBeGreaterThan(0);
    expect(body.turns).toBe(3);
    expect(typeof body.duration_ms).toBe("number");
  });

  it("threads session_id from the request through to the graph run", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("only")]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    const graph = runtime.createGraph(
      defineGraph("a").node("a", agent("A")).edge("a", END).build(),
    );

    // Capture events to confirm session_id propagation
    const seenIds: (string | undefined)[] = [];
    graph.subscribe((e) => {
      seenIds.push(e.session_id);
    });

    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
      graph_runner: graph,
    });

    const res = await app.inject({
      method: "POST",
      url: "/run",
      headers: { authorization: "Bearer k", "content-type": "application/json" },
      payload: { input: "hi", session_id: "client-supplied-1" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id: string };
    expect(body.session_id).toBe("client-supplied-1");
    expect(seenIds.every((s) => s === "client-supplied-1")).toBe(true);
  });
});
