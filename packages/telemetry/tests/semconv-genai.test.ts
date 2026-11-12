import { describe, expect, it } from "vitest";

import { genAiSpanNaming } from "../src/semconv/genai-naming.js";
import { legacySpanNaming } from "../src/semconv/naming.js";
import { makeSpan } from "./helpers/make-span.js";

const agent = (attributes = {}) => makeSpan({ kind: "agent", name: "agent.run", attributes });
const llm = (attributes = {}) => makeSpan({ kind: "llm", name: "llm.completion", attributes });
const tool = (attributes = {}) => makeSpan({ kind: "tool", name: "tool.call", attributes });

describe("genAiSpanNaming: happy path", () => {
  it("names an agent span invoke_agent {agent} and maps its attributes", () => {
    const result = genAiSpanNaming(agent({ agent_id: "assistant", session_id: "s-1", model: "m-1" }));
    expect(result).toEqual({
      name: "invoke_agent assistant",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": "assistant",
        "gen_ai.conversation.id": "s-1",
        session_id: "s-1",
        "gen_ai.request.model": "m-1",
        "tutti.kind": "agent",
      },
    });
  });

  it("names an LLM span chat {model} and maps model and token usage", () => {
    const result = genAiSpanNaming(llm({
      model: "m-1", prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540,
      cache_read_tokens: 800, cache_creation_tokens: 100, cost_usd: 0.01, router_tier: "small",
    }));
    expect(result).toEqual({
      name: "chat m-1",
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "m-1",
        "gen_ai.usage.input_tokens": 1200,
        "gen_ai.usage.output_tokens": 340,
        total_tokens: 1540,
        "gen_ai.usage.cache_read.input_tokens": 800,
        "gen_ai.usage.cache_creation.input_tokens": 100,
        cost_usd: 0.01,
        router_tier: "small",
        "tutti.kind": "llm",
      },
    });
  });

  it("names a tool span execute_tool {tool} and drops its input and output", () => {
    const result = genAiSpanNaming(tool({ tool_name: "read_file", tool_input: { p: 1 }, tool_output: "x" }));
    expect(result).toEqual({
      name: "execute_tool read_file",
      attributes: {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": "read_file",
        "tutti.kind": "tool",
      },
    });
  });

  it.each([
    makeSpan({ kind: "guardrail", name: "guardrail", attributes: { guardrail_name: "pii" } }),
    makeSpan({ kind: "checkpoint", name: "checkpoint", attributes: { session_id: "s" } }),
    makeSpan({ kind: "checkpoint", name: "checkpoint", status: "error", error: { message: "e" } }),
  ])("exports $kind spans exactly as legacy does", (span) => {
    expect(genAiSpanNaming(span)).toEqual(legacySpanNaming(span));
  });

  it("does not change the span it maps", () => {
    const span = tool({ tool_name: "t", tool_input: "in" });
    genAiSpanNaming(span);
    expect(span.name).toBe("tool.call");
    expect(span.attributes).toEqual({ tool_name: "t", tool_input: "in" });
  });
});

describe("genAiSpanNaming: missing values", () => {
  it.each([
    [agent(), "invoke_agent", "gen_ai.agent.name"],
    [llm(), "chat", "gen_ai.request.model"],
    [tool(), "execute_tool", "gen_ai.tool.name"],
  ])("falls back to the bare operation when the name is missing (%#)", (span, name, key) => {
    const result = genAiSpanNaming(span);
    expect(result.name).toBe(name);
    expect(result.attributes).not.toHaveProperty(key);
  });

  it.each(["", "   "])("treats a blank name %j as missing", (blank) => {
    const result = genAiSpanNaming(agent({ agent_id: blank, session_id: blank, model: blank }));
    expect(result.name).toBe("invoke_agent");
    expect(Object.keys(result.attributes)).toEqual(["gen_ai.operation.name", "session_id", "tutti.kind"]);
  });

  it("keeps a reported zero and leaves an unreported count out", () => {
    const result = genAiSpanNaming(llm({ model: "m", prompt_tokens: 0 }));
    expect(result.attributes["gen_ai.usage.input_tokens"]).toBe(0);
    expect(result.attributes).not.toHaveProperty("gen_ai.usage.output_tokens");
  });

  it("leaves out token counts that are not non-negative integers", () => {
    const result = genAiSpanNaming(llm({ prompt_tokens: 1.5, completion_tokens: -1, cache_read_tokens: Number.NaN }));
    expect(Object.keys(result.attributes).filter((k) => k.startsWith("gen_ai.usage"))).toEqual([]);
  });
});

describe("genAiSpanNaming: errors", () => {
  it.each([agent({ agent_id: "a" }), llm({ model: "m" }), tool({ tool_name: "t" })])(
    "sets error.type on a failed $kind span and never the message",
    (base) => {
      const span = { ...base, status: "error" as const, error: { message: "secret-ish failure text" } };
      const { attributes } = genAiSpanNaming(span);
      expect(attributes["error.type"]).toBe("_OTHER");
      expect(JSON.stringify(attributes)).not.toContain("secret-ish failure text");
    },
  );

  it("sets no error.type on a span that succeeded", () => {
    expect(genAiSpanNaming(agent({ agent_id: "a" })).attributes).not.toHaveProperty("error.type");
  });
});
