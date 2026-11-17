import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatResponse, Voice } from "@tuttiai/types";

import { InterruptDeniedError } from "../../src/errors.js";
import type { TuttiRuntime } from "../../src/runtime.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import { DAY_MS, HOUR_MS, freezeHost, wake } from "./host-pause.js";
import { boot, countingVoice, memoryStores, nextApproval, toolCalls, type Counts, type Stores } from "./restart-fixture.js";

const counts = (): Counts => ({ safe_tool: 0, danger_tool: 0, slow_tool: 0 });

interface Paused {
  host: TuttiRuntime;
  provider: ReturnType<typeof createMockProvider>;
  run: ReturnType<TuttiRuntime["run"]>;
  approval: { interrupt_id: string; session_id: string };
  settled: () => boolean;
}

/** Run on one host until the approval gate; the test then freezes and wakes it. */
async function pauseOnApproval(stores: Stores, first: ChatResponse[], voice: Voice): Promise<Paused> {
  const provider = createMockProvider([...first, textResponse("done")]);
  const host = boot(stores, provider, voice);
  const paused = nextApproval(host);
  const run = host.run("worker", "go");
  let settled = false;
  run.then(() => (settled = true), () => (settled = true));
  const approval = await paused;
  return { host, provider, run, approval, settled: (): boolean => settled };
}

/** The fixture's voice, but its `danger_tool` counts its call and then throws. */
function throwingDanger(c: Counts): Voice {
  const voice = countingVoice(c);
  const fail = (): Promise<never> => {
    c.danger_tool++;
    return Promise.reject(new Error("disk unplugged"));
  };
  return { ...voice, tools: voice.tools.map((tool) => (tool.name === "danger_tool" ? { ...tool, execute: fail } : tool)) };
}

beforeEach(() => {
  freezeHost();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a run waiting on an approval when its host is paused", () => {
  it("is not swept as dead by an 8-day pause: the approval stays pending, the checkpoint stays, the run still waits", async () => {
    const stores = memoryStores();
    const { approval, settled } = await pauseOnApproval(stores, [toolCalls("danger_tool")], countingVoice(counts()));

    await wake(8 * DAY_MS);

    // Core has no approval timeout, sweeper, lease or heartbeat: the clock alone ends nothing.
    expect((await stores.interrupts.get(approval.interrupt_id))?.status).toBe("pending");
    expect(await stores.checkpoints.loadLatest(approval.session_id)).not.toBeNull();
    expect(settled()).toBe(false);
  });

  it("resumes exactly once after a 23-hour pause, without re-running finished calls or starting a second run", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, provider, run, approval } = await pauseOnApproval(stores, [toolCalls("safe_tool"), toolCalls("danger_tool")], countingVoice(c));
    const runs = vi.spyOn(host, "run");

    await wake(23 * HOUR_MS);
    await host.resolveInterrupt(approval.interrupt_id, "approved");
    const result = await run;

    expect(result.output).toBe("done");
    expect(c).toEqual({ safe_tool: 1, danger_tool: 1, slow_tool: 0 });
    expect(runs).not.toHaveBeenCalled();
    expect(provider.chat).toHaveBeenCalledTimes(3);
  });

  // TODO(#131): change back to it() once a live run's session survives the idle TTL.
  it.fails("resumes exactly once after an 8-day pause (exposes #131: the session is evicted and the run fails after its tool ran)", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, run, approval } = await pauseOnApproval(stores, [toolCalls("danger_tool")], countingVoice(c));

    await wake(8 * DAY_MS);
    await host.resolveInterrupt(approval.interrupt_id, "approved");

    await expect(run).resolves.toMatchObject({ output: "done" });
    expect(c.danger_tool).toBe(1);
  });

  it("resumes exactly once after a short pause that stays under every timeout", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, provider, run, approval } = await pauseOnApproval(stores, [toolCalls("danger_tool")], countingVoice(c));

    await wake(1_000);
    await host.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(c.danger_tool).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(2);
  });

  it("times out a sibling call cut off by the pause once, records it in the checkpoint, and never runs it again", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, run, approval } = await pauseOnApproval(stores, [toolCalls("slow_tool", "danger_tool")], countingVoice(c));

    await wake(31_000);
    const cp = await stores.checkpoints.loadLatest(approval.session_id);
    expect(cp?.messages.at(-1)?.content).toEqual([
      expect.objectContaining({ tool_use_id: "call-slow_tool-0", is_error: true, content: expect.stringContaining("timed out") }),
    ]);

    await host.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(c).toEqual({ safe_tool: 0, danger_tool: 1, slow_tool: 1 });
  });

  it("ends the run with InterruptDeniedError on a denial after the pause, without running the call", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, run, approval } = await pauseOnApproval(stores, [toolCalls("danger_tool")], countingVoice(c));

    await wake(23 * HOUR_MS);
    await host.resolveInterrupt(approval.interrupt_id, "denied", { denial_reason: "Too late" });

    await expect(run).rejects.toBeInstanceOf(InterruptDeniedError);
    expect(c.danger_tool).toBe(0);
  });

  it("hands a tool that throws after the pause back once as an error result, without retrying it", async () => {
    const stores = memoryStores();
    const c = counts();
    const { host, provider, run, approval } = await pauseOnApproval(stores, [toolCalls("danger_tool")], throwingDanger(c));

    await wake(23 * HOUR_MS);
    await host.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(c.danger_tool).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(2);
    const results = stores.sessions.get(approval.session_id)?.messages.at(-2)?.content;
    expect(results).toEqual([expect.objectContaining({ tool_use_id: "call-danger_tool-0", is_error: true })]);
  });
});
