/**
 * A run's spent cost across an approval pause: the resumed run carries on
 * from the cost at the pause, so a `max_cost_usd` ceiling still holds.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetConfig, ChatResponse, LLMProvider, TuttiEvent, Voice } from "@tuttiai/types";

import { logger } from "../../src/logger.js";
import { TuttiRuntime } from "../../src/runtime.js";
import { createMockProvider } from "../helpers/mock-provider.js";
import { countingVoice, memoryStores, nextApproval, resumed, type Counts, type Stores } from "./restart-fixture.js";

// claude-haiku-4-5 is priced at $1 in and $5 out per million tokens.
const MODEL = "claude-haiku-4-5";

/** 100,000 in and 20,000 out: $0.20. */
const firstTurn: ChatResponse = {
  id: "r1",
  content: [{ type: "tool_use", id: "call-danger", name: "danger_tool", input: { path: "a" } }],
  stop_reason: "tool_use",
  usage: { input_tokens: 100_000, output_tokens: 20_000 },
};

/** 100,000 in and 10,000 out: $0.15. */
const secondTurn: ChatResponse = {
  id: "r2",
  content: [{ type: "text", text: "done" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 100_000, output_tokens: 10_000 },
};

function boot(stores: Stores, provider: LLMProvider, voice: Voice, budget?: BudgetConfig): TuttiRuntime {
  const worker = { name: "worker", model: MODEL, system_prompt: "Work.", voices: [voice] };
  return new TuttiRuntime(
    { name: "cost", provider, agents: { worker: budget ? { ...worker, budget } : worker } },
    { sessionStore: stores.sessions, checkpointStore: stores.checkpoints, interruptStore: stores.interrupts },
  );
}

/** Pause at the gate after a $0.20 turn, then boot a second runtime on the same stores. */
async function pauseThenRestart(before?: BudgetConfig, after: BudgetConfig | undefined = before) {
  const stores = memoryStores();
  const counts: Counts = { safe_tool: 0, danger_tool: 0, slow_tool: 0 };
  const first = boot(stores, createMockProvider([firstTurn]), countingVoice(counts), before);
  const paused = nextApproval(first);
  void first.run("worker", "clean up").catch(() => undefined);
  const approval = await paused;
  const provider = createMockProvider([secondTurn]);
  const runtime = boot(stores, provider, countingVoice(counts), after);
  const events: TuttiEvent[] = [];
  runtime.events.onAny((e) => events.push(e));
  return { stores, counts, approval, runtime, provider, events };
}

async function approve(runtime: TuttiRuntime, approval: { interrupt_id: string; session_id: string }): Promise<void> {
  await runtime.resolveInterrupt(approval.interrupt_id, "approved");
  await resumed(runtime, approval.session_id);
}

function exceeded(events: TuttiEvent[]): TuttiEvent[] {
  return events.filter((e) => e.type === "budget:exceeded");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a cost ceiling across an approval pause", () => {
  it("carries the spent cost on from the pause, so the ceiling still stops the run", async () => {
    const failed = vi.spyOn(logger, "error");
    const { counts, approval, runtime, events } = await pauseThenRestart({ max_cost_usd: 0.3 });

    await approve(runtime, approval);

    expect(counts.danger_tool).toBe(1);
    const [event] = exceeded(events);
    expect(event).toMatchObject({ type: "budget:exceeded", scope: "run", limit: 0.3 });
    expect(event?.type === "budget:exceeded" ? event.cost_usd : undefined).toBeCloseTo(0.35, 6);
    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("per-run cost budget exceeded: $0.3500") }),
      "Resumed run failed",
    );
  });

  it("stops before the approved tool runs when the ceiling was lowered during the pause", async () => {
    const { counts, approval, runtime, provider, events } = await pauseThenRestart({ max_cost_usd: 0.3 }, { max_cost_usd: 0.1 });

    await approve(runtime, approval);

    expect(counts.danger_tool).toBe(0);
    expect(provider.chat).not.toHaveBeenCalled();
    const [event] = exceeded(events);
    expect(event).toMatchObject({ type: "budget:exceeded", scope: "run", limit: 0.1 });
    expect(event?.type === "budget:exceeded" ? event.cost_usd : undefined).toBeCloseTo(0.2, 6);
  });

  it("resumes a checkpoint saved before cost was kept, counting cost from zero", async () => {
    const debug = vi.spyOn(logger, "debug");
    const { stores, counts, approval, runtime, events } = await pauseThenRestart({ max_cost_usd: 0.3 });
    const cp = await stores.checkpoints.loadLatest(approval.session_id);
    if (!cp) throw new Error("no pause checkpoint");
    delete cp.state.cost_usd_used;
    await stores.checkpoints.save(cp);

    await approve(runtime, approval);

    expect(counts.danger_tool).toBe(1);
    expect(exceeded(events)).toEqual([]);
    expect(stores.sessions.get(approval.session_id)?.messages.at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
    const legacy = debug.mock.calls.filter(([, msg]) => typeof msg === "string" && msg.includes("no saved cost"));
    expect(legacy).toEqual([[{ session: approval.session_id }, expect.any(String)]]);
  });

  it("refuses to resume a checkpoint whose saved cost is not a finite number of at least zero", async () => {
    const { stores, counts, approval, runtime, provider } = await pauseThenRestart({ max_cost_usd: 0.3 });
    const cp = await stores.checkpoints.loadLatest(approval.session_id);
    if (!cp) throw new Error("no pause checkpoint");
    cp.state.cost_usd_used = -1;
    await stores.checkpoints.save(cp);

    await approve(runtime, approval);

    expect(counts.danger_tool).toBe(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("still resumes an agent without a budget", async () => {
    const { stores, counts, approval, runtime, events } = await pauseThenRestart();

    await approve(runtime, approval);

    expect(counts.danger_tool).toBe(1);
    expect(exceeded(events)).toEqual([]);
    expect(stores.sessions.get(approval.session_id)?.messages.at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
  });
});
