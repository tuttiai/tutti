import { randomUUID } from "node:crypto";

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import type { ChatResponse, LLMProvider } from "@tuttiai/types";

import { InMemorySkillStore } from "@tuttiai/skills";
import type {
  SkillCandidate,
  Trajectory,
  TrajectoryToolCall,
} from "@tuttiai/skills";

import { EventBus } from "../../src/event-bus.js";
import { logger } from "../../src/logger.js";
import { SkillProposer } from "../../src/skills/proposer.js";
import { hashToolInput } from "../../src/skills/observer.js";

const AGENT = "support";

/** Build an `LLMProvider` whose `chat()` returns each `responses` entry in order. */
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
      };
    },
  };
}

function textResponse(text: string): ChatResponse {
  return {
    id: "resp-" + randomUUID(),
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function proposalResponse(payload: {
  name_suggestion: string;
  description: string;
}): ChatResponse {
  return textResponse(
    JSON.stringify({
      ...payload,
      signature: { input_schema: {}, output_schema: {} },
    }),
  );
}

function call(tool: string, succeeded = true): TrajectoryToolCall {
  return {
    tool,
    input_hash: hashToolInput({ tool }),
    succeeded,
    duration_ms: 5,
  };
}

function makeTrajectory(
  toolNames: string[],
  overrides: Partial<Trajectory> = {},
): Trajectory {
  const id = randomUUID();
  const ended = new Date();
  const started = new Date(ended.getTime() - 5_000);
  return {
    id,
    agent_name: AGENT,
    started_at: started,
    ended_at: ended,
    tool_calls: toolNames.map((n) => call(n)),
    outcome: "success",
    ...overrides,
  };
}

async function seed(
  store: InMemorySkillStore,
  trajectories: Trajectory[],
): Promise<void> {
  for (const t of trajectories) {
    await store.recordTrajectory(t);
  }
}

describe("SkillProposer.scanAndPropose", () => {
  it("proposes one candidate from 5 identical successful trajectories", async () => {
    const store = new InMemorySkillStore();
    await seed(
      store,
      Array.from({ length: 5 }, () =>
        makeTrajectory(["fetch_ticket", "summarise"]),
      ),
    );

    const provider = sequencedProvider([
      proposalResponse({
        name_suggestion: "summarise_ticket",
        description: "Fetch a support ticket and write a one-line summary.",
      }),
    ]);
    const events = new EventBus();
    const emitted: Array<{ candidate_id: string; agent_name: string }> = [];
    events.on("skill:proposed", (e) => {
      emitted.push({ candidate_id: e.candidate_id, agent_name: e.agent_name });
    });

    const proposer = new SkillProposer({ store, llm: provider, events });
    await proposer.scanAndPropose(AGENT);

    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.name_suggestion).toBe("summarise_ticket");
    expect(candidates[0]?.evidence_trajectory_ids).toHaveLength(5);
    expect(provider.chat).toHaveBeenCalledOnce();
    expect(emitted).toEqual([
      { candidate_id: candidates[0]!.id, agent_name: AGENT },
    ]);
  });

  it("does not propose when the cluster has only 4 trajectories", async () => {
    const store = new InMemorySkillStore();
    await seed(
      store,
      Array.from({ length: 4 }, () =>
        makeTrajectory(["fetch_ticket", "summarise"]),
      ),
    );

    const provider = sequencedProvider([]); // should never be called
    const proposer = new SkillProposer({ store, llm: provider });
    await proposer.scanAndPropose(AGENT);

    expect(await store.listCandidates()).toHaveLength(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("does not propose when 5 trajectories all have distinct tool sequences", async () => {
    const store = new InMemorySkillStore();
    await seed(store, [
      makeTrajectory(["a"]),
      makeTrajectory(["b"]),
      makeTrajectory(["c"]),
      makeTrajectory(["d"]),
      makeTrajectory(["e"]),
    ]);

    const provider = sequencedProvider([]);
    const proposer = new SkillProposer({ store, llm: provider });
    await proposer.scanAndPropose(AGENT);

    expect(await store.listCandidates()).toHaveLength(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("does not propose a duplicate when a candidate with the same signature already exists", async () => {
    const store = new InMemorySkillStore();
    const trajectories = Array.from({ length: 5 }, () =>
      makeTrajectory(["fetch_ticket", "summarise"]),
    );
    await seed(store, trajectories);

    // Pre-existing candidate whose evidence is one of the same trajectories.
    const existing: SkillCandidate = {
      id: randomUUID(),
      name_suggestion: "summarise_ticket",
      description: "An earlier proposal.",
      signature: { input: z.unknown() },
      constituent_tools: ["fetch_ticket", "summarise"],
      evidence_trajectory_ids: [trajectories[0]!.id],
      proposed_at: new Date(),
    };
    await store.proposeCandidate(existing);

    const provider = sequencedProvider([]); // should never be called
    const proposer = new SkillProposer({ store, llm: provider });
    await proposer.scanAndPropose(AGENT);

    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.id).toBe(existing.id);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("skips and warns when the LLM returns malformed JSON", async () => {
    const store = new InMemorySkillStore();
    await seed(
      store,
      Array.from({ length: 5 }, () =>
        makeTrajectory(["fetch_ticket", "summarise"]),
      ),
    );

    const provider = sequencedProvider([textResponse("not json at all")]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const proposer = new SkillProposer({ store, llm: provider });

    await expect(proposer.scanAndPropose(AGENT)).resolves.toBeUndefined();

    expect(await store.listCandidates()).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls.some(([, msg]) =>
      typeof msg === "string" && msg.includes("unparseable JSON"),
    )).toBe(true);

    warnSpy.mockRestore();
  });

  it("rejects proposals whose name collides with an existing tool", async () => {
    const store = new InMemorySkillStore();
    await seed(
      store,
      Array.from({ length: 5 }, () =>
        makeTrajectory(["fetch_ticket", "summarise"]),
      ),
    );

    // LLM proposes a name that matches one of the constituent tools.
    const provider = sequencedProvider([
      proposalResponse({
        name_suggestion: "fetch_ticket",
        description: "Collides with the existing tool name.",
      }),
    ]);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const proposer = new SkillProposer({ store, llm: provider });

    await proposer.scanAndPropose(AGENT);

    expect(await store.listCandidates()).toHaveLength(0);
    expect(warnSpy.mock.calls.some(([, msg]) =>
      typeof msg === "string" && msg.includes("collides with an existing tool"),
    )).toBe(true);

    warnSpy.mockRestore();
  });
});
