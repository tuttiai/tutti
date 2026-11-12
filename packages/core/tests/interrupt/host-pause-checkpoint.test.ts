import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse, TuttiEventType } from "@tuttiai/types";

import type { TuttiRuntime } from "../../src/runtime.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import { DAY_MS, HOUR_MS, countEvents, freezeHost, heldProvider, wake, type HeldProvider } from "./host-pause.js";
import { bootAgent, countingVoice, memoryStores, toolCalls, workerAgent, type Counts, type Stores } from "./restart-fixture.js";

interface Checkpointed {
  c: Counts;
  model: HeldProvider;
  events: Map<TuttiEventType, number>;
  run: ReturnType<TuttiRuntime["run"]>;
  session_id: string;
}

const durableWorker = (c: Counts): ReturnType<typeof workerAgent> => workerAgent(countingVoice(c), { durable: true });

/**
 * A durable run (no approval) that has run `safe_tool`, saved its checkpoint,
 * and is now inside its next model call, held, when the host is frozen.
 */
async function frozenAfterCheckpoint(stores: Stores, after: ChatResponse[] = [textResponse("done")]): Promise<Checkpointed> {
  const c: Counts = { safe_tool: 0, danger_tool: 0, slow_tool: 0 };
  const model = heldProvider([toolCalls("safe_tool"), ...after], 1);
  const host = bootAgent(stores, model.provider, durableWorker(c));
  const events = countEvents(host, ["checkpoint:saved", "checkpoint:restored", "agent:end"]);
  let session_id = "";
  host.events.on("checkpoint:saved", (e) => (session_id = e.session_id));
  const run = host.run("worker", "go");
  run.catch(() => undefined);
  await model.held;
  return { c, model, events, run, session_id };
}

beforeEach(() => {
  freezeHost();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a checkpointed run, not waiting on an approval, when its host is paused", () => {
  it("is not swept by a 23-hour pause and finishes exactly once, without restoring or re-running finished calls", async () => {
    const stores = memoryStores();
    const { c, model, events, run, session_id } = await frozenAfterCheckpoint(stores);
    expect(events.get("checkpoint:saved")).toBe(1);

    await wake(23 * HOUR_MS);
    expect(await stores.checkpoints.loadLatest(session_id)).not.toBeNull();
    model.open();
    const result = await run;

    expect(result.output).toBe("done");
    expect(c.safe_tool).toBe(1);
    expect(events.get("checkpoint:restored")).toBe(0);
    expect(events.get("agent:end")).toBe(1);
    expect(model.provider.chat).toHaveBeenCalledTimes(2);
  });

  it("finishes exactly once after a short pause that stays under every timeout", async () => {
    const stores = memoryStores();
    const { c, model, events, run } = await frozenAfterCheckpoint(stores);

    await wake(1_000);
    model.open();
    await run;

    expect(c.safe_tool).toBe(1);
    expect(events.get("agent:end")).toBe(1);
  });

  // TODO(#131): change back to it() once a live run's session survives the idle TTL.
  it.fails("finishes exactly once after an 8-day pause (exposes #131: the session is evicted and the run fails at the end)", async () => {
    const stores = memoryStores();
    const { c, model, run } = await frozenAfterCheckpoint(stores);

    await wake(8 * DAY_MS);
    model.open();

    await expect(run).resolves.toMatchObject({ output: "done" });
    expect(c.safe_tool).toBe(1);
  });

  it("fails once and keeps its checkpoint, without re-running finished calls, when the model call fails after the wake", async () => {
    const stores = memoryStores();
    const { c, model, events, run, session_id } = await frozenAfterCheckpoint(stores, []);

    await wake(2 * HOUR_MS);
    model.open();

    await expect(run).rejects.toThrow("No more mock responses");
    expect(c.safe_tool).toBe(1);
    expect(events.get("agent:end")).toBe(0);
    expect(await stores.checkpoints.loadLatest(session_id)).toMatchObject({ state: { awaiting_tool_results: true } });
  });

  it("lets a peer that runs the session during the freeze restore from the checkpoint without re-running finished calls", async () => {
    const stores = memoryStores();
    const { c, session_id } = await frozenAfterCheckpoint(stores);
    const peer = bootAgent(stores, createMockProvider([textResponse("done")]), durableWorker(c));
    const peerEvents = countEvents(peer, ["checkpoint:restored"]);

    await peer.run("worker", "", session_id);

    expect(peerEvents.get("checkpoint:restored")).toBe(1);
    expect(c.safe_tool).toBe(1);
  });

  // TODO(#133): change back to it() once only one runtime can finish a durable run's turn.
  it.fails("finishes exactly once across both hosts when a peer runs the session during the freeze (exposes #133)", async () => {
    const stores = memoryStores();
    const { c, model, events, run, session_id } = await frozenAfterCheckpoint(stores);
    const peer = bootAgent(stores, createMockProvider([textResponse("done")]), durableWorker(c));
    const peerEvents = countEvents(peer, ["agent:end"]);

    await peer.run("worker", "", session_id);
    await wake(2 * HOUR_MS);
    model.open();
    await run.catch(() => undefined);

    expect(c.safe_tool).toBe(1);
    expect((events.get("agent:end") ?? 0) + (peerEvents.get("agent:end") ?? 0)).toBe(1);
  });
});
