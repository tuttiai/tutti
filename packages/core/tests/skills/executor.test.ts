import { randomUUID } from "node:crypto";

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type {
  ChatResponse,
  LLMProvider,
  Permission,
  StreamChunk,
  Tool,
  ToolContext,
} from "@tuttiai/types";

import { InMemorySkillStore } from "@tuttiai/skills";
import type { SkillCandidate } from "@tuttiai/skills";

import { EventBus } from "../../src/event-bus.js";
import { PermissionError } from "../../src/errors.js";
import { SkillExecutor } from "../../src/skills/executor.js";
import { hashToolInput } from "../../src/skills/observer.js";

const AGENT = "support";

function textResponse(text: string): ChatResponse {
  return {
    id: "resp-" + randomUUID(),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function toolUseResponse(toolName: string, input: unknown): ChatResponse {
  return {
    id: "resp-" + randomUUID(),
    content: [
      { type: "tool_use", id: "call-" + randomUUID(), name: toolName, input },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 8 },
  };
}

function sequencedProvider(responses: ChatResponse[]): LLMProvider & {
  chat: ReturnType<typeof vi.fn>;
} {
  let i = 0;
  return {
    chat: vi.fn(async () => {
      const r = responses[i++];
      if (!r) throw new Error("Mock provider exhausted");
      return r;
    }),
    async *stream() {
      yield {
        type: "usage",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      } as StreamChunk;
    },
  };
}

const TOOL_CTX: ToolContext = { session_id: "sess-1", agent_name: AGENT };

async function seedCandidate(
  store: InMemorySkillStore,
  overrides: Partial<SkillCandidate> = {},
): Promise<SkillCandidate> {
  const trajectoryId = randomUUID();
  await store.recordTrajectory({
    id: trajectoryId,
    agent_name: AGENT,
    started_at: new Date("2026-01-01T00:00:00Z"),
    ended_at: new Date("2026-01-01T00:00:05Z"),
    tool_calls: [
      {
        tool: "read_file",
        input_hash: hashToolInput({ path: "README.md" }),
        succeeded: true,
        duration_ms: 5,
      },
    ],
    outcome: "success",
  });

  const candidate: SkillCandidate = {
    id: randomUUID(),
    name_suggestion: "fetch_docs",
    description: "Fetch the project's documentation files.",
    signature: { input: z.object({ topic: z.string() }) },
    constituent_tools: ["read_file"],
    evidence_trajectory_ids: [trajectoryId],
    proposed_at: new Date(),
    ...overrides,
  };
  await store.proposeCandidate(candidate);
  return candidate;
}

describe("SkillExecutor.toolsForAgent", () => {
  it("returns approved skills as callable tools", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    await store.approveCandidate(candidate.id);

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([]),
    });
    const tools = await executor.toolsForAgent(AGENT);

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("fetch_docs");
    expect(tools[0]?.description).toBe(
      "Fetch the project's documentation files.",
    );
  });

  it("omits rejected skills", async () => {
    const store = new InMemorySkillStore();
    const approved = await seedCandidate(store, { name_suggestion: "good" });
    const rejected = await seedCandidate(store, { name_suggestion: "bad" });
    await store.approveCandidate(approved.id);
    await store.rejectCandidate(rejected.id);

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([]),
    });
    const tools = await executor.toolsForAgent(AGENT);

    expect(tools.map((t) => t.name)).toEqual(["good"]);
  });

  it("prefixes the skill name when it collides with a voice tool", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store, {
      name_suggestion: "read_file",
    });
    await store.approveCandidate(candidate.id);

    const voiceTool: Tool = {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: z.object({ path: z.string() }),
      execute: vi.fn(async () => ({ content: "voice result" })),
    };

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([]),
    });
    const tools = await executor.toolsForAgent(AGENT, {
      tools: [voiceTool],
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("skill__read_file");
  });

  it("throws PermissionError when the agent lacks a required permission at run start", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    await store.approveCandidate(candidate.id, {
      required_permissions: ["filesystem", "network"],
    });

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([]),
    });
    const granted: Permission[] = ["filesystem"];

    await expect(
      executor.toolsForAgent(AGENT, { grantedPermissions: granted }),
    ).rejects.toBeInstanceOf(PermissionError);
  });

  it("emits skill:invoked when a skill tool is called", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    const skill = await store.approveCandidate(candidate.id);

    const events = new EventBus();
    const seen: Array<{ agent_name: string; skill_id: string; run_id: string }> = [];
    events.on("skill:invoked", (e) => {
      seen.push({
        agent_name: e.agent_name,
        skill_id: e.skill_id,
        run_id: e.run_id,
      });
    });

    // One inner-loop chat call that terminates immediately with text.
    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([textResponse("done")]),
      events,
    });
    const tools = await executor.toolsForAgent(AGENT, {
      runId: "run-xyz",
    });
    const skillTool = tools[0];
    expect(skillTool).toBeDefined();

    const result = await skillTool!.execute({ topic: "intro" }, TOOL_CTX);
    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("done");
    expect(seen).toEqual([
      { agent_name: AGENT, skill_id: skill.id, run_id: "run-xyz" },
    ]);
  });

  it("forwards is_destructive from the approved skill onto the tool definition", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    await store.approveCandidate(candidate.id, { is_destructive: true });

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([]),
    });
    const tools = await executor.toolsForAgent(AGENT);

    expect(tools[0]?.destructive).toBe(true);
  });

  it("runs the inner loop with constituent tools and returns the final text", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    await store.approveCandidate(candidate.id);

    const readFile: Tool = {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: z.object({ path: z.string() }),
      execute: vi.fn(async () => ({ content: "file contents: hello" })),
    };

    const executor = new SkillExecutor({
      store,
      llm: sequencedProvider([
        // First inner turn: model asks to call the constituent.
        toolUseResponse("read_file", { path: "README.md" }),
        // Second inner turn: model wraps up with a text reply.
        textResponse("summary: hello"),
      ]),
    });
    const tools = await executor.toolsForAgent(AGENT, {
      tools: [readFile],
    });

    const result = await tools[0]!.execute({ topic: "intro" }, TOOL_CTX);
    expect(result.content).toBe("summary: hello");
    expect(readFile.execute).toHaveBeenCalledOnce();
  });

  it("returns an is_error result when the inner loop exhausts maxTurns", async () => {
    const store = new InMemorySkillStore();
    const candidate = await seedCandidate(store);
    await store.approveCandidate(candidate.id);

    const readFile: Tool = {
      name: "read_file",
      description: "Read a file from disk.",
      parameters: z.object({ path: z.string() }),
      execute: vi.fn(async () => ({ content: "ok" })),
    };

    // Every inner turn says "use the tool again" — the model never
    // commits to a final text reply.
    const provider = sequencedProvider([
      toolUseResponse("read_file", { path: "a" }),
      toolUseResponse("read_file", { path: "b" }),
    ]);

    const executor = new SkillExecutor({
      store,
      llm: provider,
      maxTurns: 2,
    });
    const tools = await executor.toolsForAgent(AGENT, {
      tools: [readFile],
    });

    const result = await tools[0]!.execute({ topic: "intro" }, TOOL_CTX);
    expect(result.is_error).toBe(true);
    expect(result.content).toMatch(/within 2 inner turns/);
  });
});
