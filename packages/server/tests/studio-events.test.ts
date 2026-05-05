import { afterEach, describe, expect, it } from "vitest";

import { defineGraph, END, TuttiRuntime } from "@tuttiai/core";
import type { AgentConfig, ChatResponse, ScoreConfig } from "@tuttiai/types";

import { createServer } from "../src/index.js";
import { buildTestServer, textResponse } from "./helpers.js";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are ${name}.`,
    voices: [],
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

describe("GET /studio/events", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns 404 when no graph runner is configured", async () => {
    ({ app } = await buildTestServer([textResponse("unused")], {
      config: { api_key: "k" },
    }));

    const res = await app.inject({
      method: "GET",
      url: "/studio/events",
      headers: { authorization: "Bearer k" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("studio_events_unavailable");
  });

  it("opens an SSE stream and bypasses auth when a graph runner is set", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([textResponse("a")]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    const graph = runtime.createGraph(
      defineGraph("x").node("x", agent("x")).edge("x", END).build(),
    );

    app = await createServer({
      port: 0,
      host: "127.0.0.1",
      runtime,
      agent_name: "entry",
      api_key: "k",
      graph_runner: graph,
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    // Real HTTP request — `app.inject` won't return until the SSE
    // stream closes, which is on request abort.
    const controller = new AbortController();
    const res = await fetch(address + "/studio/events", {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");

    controller.abort();
  });

  it("streams run lifecycle events for a graph run", async () => {
    const score: ScoreConfig = {
      provider: mockProvider([
        textResponse("a-out"),
        textResponse("b-out"),
      ]),
      agents: { entry: agent("entry") },
    };
    const runtime = new TuttiRuntime(score);
    const graph = runtime.createGraph(
      defineGraph("a")
        .node("a", agent("A"))
        .node("b", agent("B"))
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
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    // Open the SSE stream first, then trigger a run, then collect frames.
    const controller = new AbortController();
    const sse = await fetch(address + "/studio/events", { signal: controller.signal });
    const reader = sse.body?.getReader();
    if (!reader) throw new Error("no SSE body");

    const events: Array<{ type: string }> = [];
    const done = (async (): Promise<void> => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        while (true) {
          const { value, done: rDone } = await reader.read();
          if (rDone) return;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            events.push(JSON.parse(dataLine.slice(6)));
          }
        }
      } catch {
        /* aborted */
      }
    })();

    // Trigger the run
    const runRes = await fetch(address + "/run", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer k" },
      body: JSON.stringify({ input: "go", session_id: "test-session" }),
    });
    expect(runRes.status).toBe(200);

    // Give the SSE pipe a tick to flush.
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await done;

    const types = events.map((e) => e.type);
    expect(types).toContain("run:start");
    expect(types).toContain("node:start");
    expect(types).toContain("node:complete");
    expect(types).toContain("run:complete");

    // run:complete must include the path
    const complete = events.find((e) => e.type === "run:complete") as
      | { path: string[]; session_id: string }
      | undefined;
    expect(complete?.path).toEqual(["a", "b"]);
    expect(complete?.session_id).toBe("test-session");
  });
});
