/**
 * End-to-end integration test for the self-improving-skills loop.
 *
 * Drives the full pipeline with `MockLLMProvider` only — no network,
 * no real keys — and asserts:
 *
 *   1. Five runs of the same agent with the same tool sequence land
 *      as five trajectories tagged `outcome: "success"`.
 *   2. `SkillProposer.scanAndPropose` produces exactly one candidate.
 *   3. `SkillStore.approveCandidate` makes the skill available.
 *   4. The sixth run sees the skill registered as an additional tool
 *      and the LLM invokes it (`skill:invoked` fires).
 *
 * The test skips cleanly when `ANTHROPIC_API_KEY` is unset because it
 * does not need one — every LLM call is mocked.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AgentConfig,
  ChatRequest,
  ChatResponse,
  Tool,
  TuttiEvent,
  Voice,
} from "@tuttiai/types";
import { InMemorySkillStore } from "@tuttiai/skills";

import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { SkillExecutor } from "../../src/skills/executor.js";
import { SkillProposer } from "../../src/skills/proposer.js";
import { TrajectoryObserver } from "../../src/skills/observer.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
} from "../helpers/mock-provider.js";

const AGENT_NAME = "code-reviewer";
const PROPOSED_SKILL_NAME = "review_pr";

/**
 * Mock voice that exposes the three constituents the demo PR-review
 * sequence calls. Each tool just echoes a stable string so the runner
 * marks the call succeeded.
 */
function mockReviewVoice(): Voice {
  const reads: string[] = [];
  return {
    name: "review-mock",
    required_permissions: [],
    tools: [
      {
        name: "get_pull_request",
        description: "Fetch a pull request by number.",
        parameters: z.object({ number: z.number() }),
        execute: vi.fn(async (input: { number: number }) => ({
          content: `pr ${input.number}: 2 changed files (a.ts, b.ts)`,
        })),
      },
      {
        name: "get_file_contents",
        description: "Fetch a file's contents.",
        parameters: z.object({ path: z.string() }),
        execute: vi.fn(async (input: { path: string }) => {
          reads.push(input.path);
          return { content: `contents of ${input.path}` };
        }),
      },
      {
        name: "comment_on_issue",
        description: "Post a review comment on the PR's issue.",
        parameters: z.object({ number: z.number(), body: z.string() }),
        execute: vi.fn(async () => ({ content: "comment posted" })),
      },
    ],
  };
}

/**
 * Canned response sequence for one PR-review run: four LLM calls
 * (three tool_use, one final text). The outer loop appends one
 * `assistant` message per response and processes any tool_use blocks
 * by calling the voice tool, so this drives a fully deterministic
 * `get_pull_request → get_file_contents → comment_on_issue` shape.
 */
function singleRunResponses(prNumber: number): ChatResponse[] {
  return [
    toolUseResponse(
      "get_pull_request",
      { number: prNumber },
      `gp-${prNumber}`,
    ),
    toolUseResponse(
      "get_file_contents",
      { path: "a.ts" },
      `gf-${prNumber}-1`,
    ),
    toolUseResponse(
      "comment_on_issue",
      { number: prNumber, body: "LGTM with nits." },
      `ci-${prNumber}`,
    ),
    textResponse(`Reviewed PR #${prNumber}: 1 nit on a.ts.`),
  ];
}

/**
 * Build the response sequence for the first five PR-review runs.
 * Order matters — the mock provider serves these in turn.
 */
function fiveRunResponses(): ChatResponse[] {
  return [1, 2, 3, 4, 5].flatMap(singleRunResponses);
}

/**
 * Response shape that the proposer's `chat()` call expects: a single
 * text block holding a JSON object with `name_suggestion`,
 * `description`, and a `signature` placeholder. The proposer parses
 * this via {@link SkillCandidateProposalSchema}.
 */
function proposerResponse(): ChatResponse {
  return textResponse(
    JSON.stringify({
      name_suggestion: PROPOSED_SKILL_NAME,
      description:
        "Review a pull request: fetch the diff, read each changed " +
        "file, and post a consolidated review comment.",
      signature: { input_schema: {}, output_schema: {} },
    }),
  );
}

/**
 * Build the agent we exercise end-to-end. The system prompt mirrors
 * the example score so the test stays a faithful integration check
 * rather than a synthetic micro-bench.
 */
function buildAgent(voices: Voice[]): AgentConfig {
  return {
    name: AGENT_NAME,
    model: "test-model",
    system_prompt:
      "Review the user's PR. Read each changed file, comment on issues, summarise.",
    voices,
  };
}

/**
 * Wait until the trajectory observer has emitted
 * `skill:trajectory_recorded` `count` times, or fail loud after the
 * timeout. Beats a flat `setTimeout` because the observer's
 * `recordTrajectory` is fire-and-forget from the runner's perspective.
 */
async function waitForTrajectories(
  events: EventBus,
  count: number,
  timeoutMs = 1000,
): Promise<void> {
  let seen = 0;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${count} trajectories; only saw ${seen}`,
        ),
      );
    }, timeoutMs);
    const unsubscribe = events.on("skill:trajectory_recorded", () => {
      seen++;
      if (seen >= count) {
        clearTimeout(t);
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("Skills self-improvement loop", () => {
  it("records 5 trajectories, proposes 1 candidate, then exposes the skill on run 6", async () => {
    const store = new InMemorySkillStore();
    const events = new EventBus();
    const sessions = new InMemorySessionStore();

    // ─── First five runs ─────────────────────────────────────────
    //
    // We use a real `LLMProvider` rather than the `SkillProposer`'s
    // mock so the proposer's later call can share the same provider
    // by appending to the response queue. The mock is created once
    // per test with every response the test will need across runs 1–6
    // and the proposer scan; see comments below for slot layout.
    const responses: ChatResponse[] = [
      ...fiveRunResponses(), //   slots  0..19 — five PR-review runs (4 chat() each)
      proposerResponse(), //      slot   20    — single proposal call
      // Run 6 (after approval): outer loop uses the new skill, then
      // wraps up with a final text turn. The skill's inner loop also
      // makes one chat() call which terminates immediately with text.
      toolUseResponse(
        PROPOSED_SKILL_NAME,
        { number: 6 },
        "outer-skill-1",
      ), // slot 21 — outer turn 1
      textResponse("inner: review_pr done"), // slot 22 — inner-loop turn
      textResponse("Reviewed PR #6 via the new skill."), // slot 23 — outer turn 2
    ];
    const provider = createMockProvider(responses);

    // The observer's default `minDurationMs` is 1s — too slow for a
    // mocked test. Drop the floor so the very short runs land in the
    // store. The proposer threshold is dropped to 5 to match the
    // demo's "5 runs" contract.
    const proposer = new SkillProposer({
      store,
      llm: provider,
      autoProposeThreshold: 5,
      // Bypass the per-agent count guard for the test — the proposer
      // is awaited explicitly below so we don't need the observer's
      // background kick to fire.
      events,
    });
    const observer = new TrajectoryObserver({
      store,
      events,
      minDurationMs: 0,
      // No `proposer` here: we await `scanAndPropose` explicitly
      // below so the assertion order is deterministic.
    });
    const executor = new SkillExecutor({
      store,
      llm: provider,
      events,
      // One inner turn is enough — our mocked response ends with
      // text on the first inner call.
      maxTurns: 1,
    });

    const voice = mockReviewVoice();
    const agent = buildAgent([voice]);

    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined, // semanticMemory
      undefined, // globalHooks
      undefined, // toolCache
      undefined, // checkpointStore
      undefined, // interruptStore
      undefined, // runCostStore
      observer,
      executor,
    );

    // Drive the first five runs and wait until every one of them has
    // landed in the store before asserting.
    const recorded = waitForTrajectories(events, 5);
    for (let i = 1; i <= 5; i++) {
      const result = await runner.run(agent, `Review PR #${i}`);
      expect(result.turns).toBe(4); // 3 tool turns + 1 final text
    }
    await recorded;

    const trajectories = await store.listTrajectories(AGENT_NAME);
    expect(trajectories).toHaveLength(5);
    expect(trajectories.every((t) => t.outcome === "success")).toBe(true);
    expect(
      trajectories[0]?.tool_calls.map((c) => c.tool),
    ).toEqual([
      "get_pull_request",
      "get_file_contents",
      "comment_on_issue",
    ]);

    // ─── Proposer scan ───────────────────────────────────────────
    await proposer.scanAndPropose(AGENT_NAME);
    const candidates = await store.listCandidates();
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.name_suggestion).toBe(PROPOSED_SKILL_NAME);
    expect(candidate.evidence_trajectory_ids).toHaveLength(5);
    expect(candidate.constituent_tools).toEqual([
      "get_pull_request",
      "get_file_contents",
      "comment_on_issue",
    ]);

    // ─── Approve via the store directly ──────────────────────────
    const skill = await store.approveCandidate(candidate.id, {
      reviewed_by: "test-operator",
    });
    expect(skill.status).toBe("approved");
    expect((await store.listCandidates())).toHaveLength(0);

    // ─── Sixth run: the skill is now a tool ──────────────────────
    const skillEvents: TuttiEvent[] = [];
    events.on("skill:invoked", (e) => skillEvents.push(e));

    // Reset the chat spy's call log so we can assert on the run-6
    // request shape independent of the first five runs.
    provider.chat.mockClear();

    const result6 = await runner.run(agent, "Review PR #6");

    // Outer loop made two `chat` calls (skill use + final text).
    // The inner loop adds one. The exact total being 3 is the contract
    // we lock in here — if the runner ever changes its inner/outer
    // accounting this assertion will catch it.
    expect(provider.chat).toHaveBeenCalledTimes(3);

    // Run-6's first outer chat() must offer the new skill as a tool.
    const firstOuterCall = provider.chat.mock.calls[0]?.[0] as ChatRequest;
    const toolNames = (firstOuterCall.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain(PROPOSED_SKILL_NAME);

    // The skill was actually invoked.
    expect(skillEvents).toHaveLength(1);
    expect(skillEvents[0]?.type).toBe("skill:invoked");
    if (skillEvents[0]?.type === "skill:invoked") {
      expect(skillEvents[0].agent_name).toBe(AGENT_NAME);
      expect(skillEvents[0].skill_id).toBe(skill.id);
    }

    // The final assistant text is what the LLM returned, not what the
    // skill's inner loop emitted — that one was consumed as the tool
    // result.
    expect(result6.output).toBe("Reviewed PR #6 via the new skill.");
  });
});
