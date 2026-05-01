import type { ChatRequest, ToolDefinition } from "@tuttiai/types";
import { describe, expect, it } from "vitest";
import { HeuristicClassifier } from "../src/heuristic.js";
import type { ClassifierContext, ModelTier, RoutingPolicy } from "../src/types.js";

const TIERS: ModelTier[] = [
  // Provider stubs are unused by the heuristic — only the shape matters.
  { tier: "small", provider: { chat: async () => ({} as never), stream: async function* () {} }, model: "small-m" },
  { tier: "medium", provider: { chat: async () => ({} as never), stream: async function* () {} }, model: "medium-m" },
  { tier: "large", provider: { chat: async () => ({} as never), stream: async function* () {} }, model: "large-m" },
];

function ctx(policy: RoutingPolicy, overrides: Partial<ClassifierContext> = {}): ClassifierContext {
  return { tiers: TIERS, policy, ...overrides };
}

function userReq(text: string, tools?: ToolDefinition[]): ChatRequest {
  return {
    messages: [{ role: "user", content: text }],
    ...(tools ? { tools } : {}),
  };
}

/** Build a fake tool definition. The optional `destructive` flag is read by the heuristic via a structural cast. */
function tool(name: string, destructive = false): ToolDefinition {
  return { name, description: name, input_schema: {}, ...(destructive ? { destructive } : {}) } as ToolDefinition & {
    destructive?: boolean;
  };
}

describe("HeuristicClassifier", () => {
  const classifier = new HeuristicClassifier();

  it("routes a simple summarise prompt under cost-optimised to 'small'", async () => {
    const tier = await classifier.classify(
      userReq("summarise this paragraph in one line"),
      ctx("cost-optimised"),
    );
    expect(tier).toBe("small");
  });

  it("routes a code-heavy refactor prompt under cost-optimised to 'medium'", async () => {
    const prompt = "refactor this for me:\n```ts\nconst x = 1;\nfunction foo() { return x + 1; }\n```";
    const tier = await classifier.classify(userReq(prompt), ctx("cost-optimised"));
    expect(tier).toBe("medium");
  });

  it("routes a code-heavy refactor prompt under balanced to 'large'", async () => {
    const prompt = "refactor this for me:\n```ts\nconst x = 1;\nfunction foo() { return x + 1; }\n```";
    const tier = await classifier.classify(userReq(prompt), ctx("balanced"));
    expect(tier).toBe("large");
  });

  it("escalates at least one tier when previous_stop_reason is 'max_tokens' (cost-optimised)", async () => {
    const tier = await classifier.classify(
      userReq("summarise this short paragraph"),
      ctx("cost-optimised", { previous_stop_reason: "max_tokens" }),
    );
    expect(tier).toBe("medium");
  });

  it("escalates at least one tier when previous_stop_reason is 'max_tokens' (balanced)", async () => {
    const tier = await classifier.classify(
      userReq("summarise this short paragraph"),
      ctx("balanced", { previous_stop_reason: "max_tokens" }),
    );
    expect(tier).toBe("large");
  });

  it("always returns 'large' under quality-first", async () => {
    const tinyPrompt = userReq("hi");
    const codePrompt = userReq("```ts\nconst x = 1;\n```");
    const longPrompt = userReq("a ".repeat(20));
    expect(await classifier.classify(tinyPrompt, ctx("quality-first"))).toBe("large");
    expect(await classifier.classify(codePrompt, ctx("quality-first"))).toBe("large");
    expect(await classifier.classify(longPrompt, ctx("quality-first"))).toBe("large");
  });

  it("routes a long user message that exceeds the 8000-token estimate under balanced to 'large'", async () => {
    // 32004 chars → ceil(32004 / 4) = 8001 token estimate, which trips the balanced branch's tokenEstimate > 8000 rule.
    const tier = await classifier.classify(userReq("a".repeat(32004)), ctx("balanced"));
    expect(tier).toBe("large");
  });

  it("escalates to 'large' under balanced when one destructive tool is loaded", async () => {
    const tier = await classifier.classify(
      userReq("hello", [tool("delete_branch", true)]),
      ctx("balanced"),
    );
    expect(tier).toBe("large");
  });

  it("escalates to 'medium' under cost-optimised when two destructive tools are loaded", async () => {
    const tier = await classifier.classify(
      userReq("hello", [tool("delete_branch", true), tool("force_push", true)]),
      ctx("cost-optimised"),
    );
    expect(tier).toBe("medium");
  });

  it("keeps a simple prompt on 'small' under cost-optimised even with one destructive tool", async () => {
    const tier = await classifier.classify(
      userReq("summarise this paragraph in one line", [tool("delete_branch", true)]),
      ctx("cost-optimised"),
    );
    expect(tier).toBe("small");
  });

  it("uses ctx.destructive_tool_count override over req.tools when provided", async () => {
    // Two destructive tools in req.tools → would normally trip cost-optimised's >=2 branch to 'medium'.
    // But the override forces destructiveCount = 0, so the simple-prompt path wins instead.
    const tools = [tool("delete_branch", true), tool("force_push", true)];
    const overriddenZero = await classifier.classify(
      userReq("summarise this paragraph in one line", tools),
      ctx("cost-optimised", { destructive_tool_count: 0 }),
    );
    expect(overriddenZero).toBe("small");

    // Inverse — req.tools have zero destructive tools, but the override claims two:
    // cost-optimised should now escalate to 'medium' purely because of the override.
    const overriddenTwo = await classifier.classify(
      userReq("summarise this paragraph in one line", [tool("read_file"), tool("list_files")]),
      ctx("cost-optimised", { destructive_tool_count: 2 }),
    );
    expect(overriddenTwo).toBe("medium");
  });
});
