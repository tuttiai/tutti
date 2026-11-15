import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResult } from "@tuttiai/types";

import { InterruptDeniedError } from "../../src/errors.js";
import { DEFAULT_SESSION_IDLE_TTL_MS } from "../../src/session-lru.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import {
  boot,
  countingVoice,
  memoryStores,
  nextApproval,
  toolCalls,
  type Counts,
  type Stores,
} from "./restart-fixture.js";

const DAY = 86_400_000;

type Outcome = { ok: true; result: AgentResult } | { ok: false; error: unknown };

interface Paused {
  stores: Stores;
  counts: Counts;
  session_id: string;
  outcome: Outcome;
}

/** Pause on `danger_tool`, let `ms` pass on the fake clock, then decide on the same runtime. */
async function pauseFor(ms: number, decision: "approved" | "denied"): Promise<Paused> {
  const stores = memoryStores();
  const counts: Counts = { safe_tool: 0, danger_tool: 0, slow_tool: 0 };
  const provider = createMockProvider([toolCalls("danger_tool"), textResponse("done")]);
  const runtime = boot(stores, provider, countingVoice(counts));
  const paused = nextApproval(runtime);
  const settled = runtime.run("worker", "clean up").then(
    (result): Outcome => ({ ok: true, result }),
    (error: unknown): Outcome => ({ ok: false, error }),
  );
  const approval = await paused;
  await vi.advanceTimersByTimeAsync(ms);
  await runtime.resolveInterrupt(approval.interrupt_id, decision);
  return { stores, counts, session_id: approval.session_id, outcome: await settled };
}

function lastContent(paused: Paused): unknown {
  return paused.stores.sessions.get(paused.session_id)?.messages.at(-1)?.content;
}

describe("a run paused for approval longer than the session idle TTL (#131)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "setInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes into its session and runs the tool exactly once", async () => {
    const paused = await pauseFor(8 * DAY, "approved");

    expect(paused.outcome).toMatchObject({ ok: true, result: { output: "done" } });
    expect(paused.counts.danger_tool).toBe(1);
    expect(lastContent(paused)).toEqual([{ type: "text", text: "done" }]);
  });

  it("finishes when resumed at exactly the TTL", async () => {
    const paused = await pauseFor(DEFAULT_SESSION_IDLE_TTL_MS, "approved");

    expect(paused.outcome.ok).toBe(true);
    expect(paused.counts.danger_tool).toBe(1);
    expect(lastContent(paused)).toEqual([{ type: "text", text: "done" }]);
  });

  it("finishes when resumed one millisecond past the TTL", async () => {
    const paused = await pauseFor(DEFAULT_SESSION_IDLE_TTL_MS + 1, "approved");

    expect(paused.outcome.ok).toBe(true);
    expect(paused.counts.danger_tool).toBe(1);
    expect(lastContent(paused)).toEqual([{ type: "text", text: "done" }]);
  });

  it("still ends with InterruptDeniedError on a denial, without running the tool", async () => {
    const paused = await pauseFor(8 * DAY, "denied");

    expect(paused.outcome.ok).toBe(false);
    expect(paused.outcome.ok ? undefined : paused.outcome.error).toBeInstanceOf(InterruptDeniedError);
    expect(paused.counts.danger_tool).toBe(0);
  });
});
