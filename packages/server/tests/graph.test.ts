import { afterEach, describe, expect, it } from "vitest";

import { END, defineGraph } from "@tuttiai/core";
import type { AgentConfig, ChatResponse } from "@tuttiai/types";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

function agent(name: string): AgentConfig {
  return {
    name,
    model: "test-model",
    system_prompt: `You are ${name}.`,
    voices: [],
  };
}

const HEADERS = { authorization: "Bearer " + API_KEY };

describe("GET /graph", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns an empty graph when no graph is configured", async () => {
    ({ app } = await buildTestServer([textResponse("unused") as ChatResponse]));

    const res = await app.inject({ method: "GET", url: "/graph", headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nodes: [], edges: [] });
  });

  it("returns the configured graph as JSON", async () => {
    const graph = defineGraph("planner")
      .node("planner", agent("planner"))
      .node("coder", agent("coder"), { description: "writes code" })
      .node("qa", agent("qa"))
      .edge("planner", "coder", { label: "plan-ok" })
      .edge("coder", "qa")
      .edge("qa", END)
      .build();

    ({ app } = await buildTestServer([textResponse("unused") as ChatResponse], {
      config: { graph },
    }));

    const res = await app.inject({ method: "GET", url: "/graph", headers: HEADERS });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      entrypoint?: string;
      nodes: { id: string; description?: string }[];
      edges: { source: string; target: string; label?: string; has_condition?: boolean }[];
    };
    expect(body.entrypoint).toBe("planner");
    expect(body.nodes.map((n) => n.id).sort()).toEqual(["__end__", "coder", "planner", "qa"]);
    expect(body.nodes.find((n) => n.id === "coder")?.description).toBe("writes code");
    expect(body.edges).toHaveLength(3);
    expect(body.edges.find((e) => e.label === "plan-ok")).toBeDefined();
  });

  it("flags conditional edges with has_condition", async () => {
    const graph = defineGraph("classifier")
      .node("classifier", agent("classifier"))
      .node("yes", agent("yes"))
      .node("no", agent("no"))
      .edge("classifier", "yes", { condition: () => true })
      .edge("classifier", "no", { condition: () => false })
      .edge("yes", END)
      .edge("no", END)
      .build();

    ({ app } = await buildTestServer([textResponse("unused") as ChatResponse], {
      config: { graph },
    }));

    const res = await app.inject({ method: "GET", url: "/graph", headers: HEADERS });
    const body = res.json() as {
      edges: { source: string; target: string; has_condition?: boolean }[];
    };

    const fromClassifier = body.edges.filter((e) => e.source === "classifier");
    expect(fromClassifier).toHaveLength(2);
    for (const e of fromClassifier) {
      expect(e.has_condition).toBe(true);
    }

    const toEnd = body.edges.filter((e) => e.target === "__end__");
    expect(toEnd).toHaveLength(2);
    for (const e of toEnd) {
      expect(e.has_condition).toBeUndefined();
    }
  });
});
