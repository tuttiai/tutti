import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TuttiRuntime } from "../../src/runtime.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import { HOUR_MS, freezeHost, wake } from "./host-pause.js";
import { boot, countingVoice, memoryStores, nextApproval, resumed, toolCalls, type Counts, type Stores } from "./restart-fixture.js";

interface FrozenWithPeer {
  c: Counts;
  frozen: TuttiRuntime;
  run: ReturnType<TuttiRuntime["run"]>;
  approval: { interrupt_id: string; session_id: string };
  peer: TuttiRuntime;
  peerProvider: ReturnType<typeof createMockProvider>;
}

/**
 * A run paused on `danger_tool` on the host about to be frozen, and a second
 * runtime (the peer) on the same stores, which can act while it is frozen.
 * Calls are counted across both.
 */
async function frozenWithPeer(stores: Stores): Promise<FrozenWithPeer> {
  const c: Counts = { safe_tool: 0, danger_tool: 0, slow_tool: 0 };
  const frozen = boot(stores, createMockProvider([toolCalls("danger_tool"), textResponse("done")]), countingVoice(c));
  const paused = nextApproval(frozen);
  const run = frozen.run("worker", "go");
  run.catch(() => undefined);
  const approval = await paused;
  const peerProvider = createMockProvider([textResponse("done")]);
  const peer = boot(stores, peerProvider, countingVoice(c));
  return { c, frozen, run, approval, peer, peerProvider };
}

beforeEach(() => {
  freezeHost();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a paused host and a second runtime on the same stores", () => {
  it("runs the call once when an approval recorded in the store during the freeze reaches the woken host", async () => {
    const stores = memoryStores();
    const { c, frozen, run, approval } = await frozenWithPeer(stores);

    await stores.interrupts.resolve(approval.interrupt_id, "approved");
    await wake(2 * HOUR_MS);
    // Core does not poll the store: the woken run goes on only when resolveInterrupt reaches this host.
    await frozen.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(c.danger_tool).toBe(1);
  });

  it("runs the call once, on the peer, when the peer resolves the approval during the freeze", async () => {
    const stores = memoryStores();
    const { c, approval, peer, peerProvider } = await frozenWithPeer(stores);

    await peer.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(peer, approval.session_id);
    await wake(2 * HOUR_MS);

    expect(c.danger_tool).toBe(1);
    expect(peerProvider.chat).toHaveBeenCalledTimes(1);
  });

  // TODO(#132): change back to it() once a resolve that finds the approval already resolved releases no waiter.
  it.fails("runs the call once when the peer resolves during the freeze and the woken host is resolved again (exposes #132)", async () => {
    const stores = memoryStores();
    const { c, frozen, run, approval, peer } = await frozenWithPeer(stores);

    await peer.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(peer, approval.session_id);
    await wake(2 * HOUR_MS);
    await frozen.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(c.danger_tool).toBe(1);
  });

  it("runs the call once when both hosts resolve at once on wake and the woken host's call lands first", async () => {
    const stores = memoryStores();
    const { c, frozen, run, approval, peer } = await frozenWithPeer(stores);

    await wake(2 * HOUR_MS);
    await Promise.all([
      frozen.resolveInterrupt(approval.interrupt_id, "approved"),
      peer.resolveInterrupt(approval.interrupt_id, "approved"),
    ]);
    await resumed(peer, approval.session_id);
    await run;

    expect(c.danger_tool).toBe(1);
  });

  // TODO(#132): change back to it() with the case above.
  it.fails("runs the call once when both hosts resolve at once on wake and the peer's call lands first (exposes #132)", async () => {
    const stores = memoryStores();
    const { c, frozen, run, approval, peer } = await frozenWithPeer(stores);

    await wake(2 * HOUR_MS);
    await Promise.all([
      peer.resolveInterrupt(approval.interrupt_id, "approved"),
      frozen.resolveInterrupt(approval.interrupt_id, "approved"),
    ]);
    await resumed(peer, approval.session_id);
    await run;

    expect(c.danger_tool).toBe(1);
  });

  it("takes the invalid-checkpoint path on the peer and runs nothing there when the checkpoint is unreadable on wake", async () => {
    const stores = memoryStores();
    const { c, frozen, run, approval, peer, peerProvider } = await frozenWithPeer(stores);
    const cp = await stores.checkpoints.loadLatest(approval.session_id);
    if (!cp) throw new Error("the pause wrote no checkpoint");
    // Names a call the paused turn never made, so planResume reads the checkpoint as invalid.
    await stores.checkpoints.save({ ...cp, state: { ...cp.state, pending_tool_ids: ["call-unknown"] } });

    await wake(2 * HOUR_MS);
    await peer.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(peer, approval.session_id);
    expect(c.danger_tool).toBe(0);
    expect(peerProvider.chat).not.toHaveBeenCalled();

    await frozen.resolveInterrupt(approval.interrupt_id, "approved");
    await run;
    expect(c.danger_tool).toBe(1);
  });
});
