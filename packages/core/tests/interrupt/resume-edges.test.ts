import { afterEach, describe, expect, it, vi } from "vitest";

import { InterruptDeniedError, RunAbortedError } from "../../src/errors.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import {
  DurableCheckpoints,
  DurableInterrupts,
  boot,
  countingVoice,
  memoryStores,
  nextApproval,
  nextResolution,
  resumed,
  toolCalls,
  type Counts,
  type Stores,
} from "./restart-fixture.js";

const counts = (): Counts => ({ safe_tool: 0, danger_tool: 0, slow_tool: 0 });

async function pause(stores: Stores, c: Counts, signal?: AbortSignal) {
  const runtime = boot(stores, createMockProvider([toolCalls("danger_tool"), textResponse("done")]), countingVoice(c));
  const paused = nextApproval(runtime);
  const run = runtime.run("worker", "go", undefined, signal ? { signal } : undefined);
  run.catch(() => undefined);
  return { runtime, run, approval: await paused };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resume edge cases", () => {
  it("records the approval and resumes nothing when the pause checkpoint is gone", async () => {
    const stores = memoryStores();
    const c = counts();
    const { approval } = await pause(stores, c);
    await stores.checkpoints.delete(approval.session_id);
    const provider = createMockProvider([]);
    const after = boot(stores, provider, countingVoice(c));

    const record = await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);

    expect(record.status).toBe("approved");
    expect(c.danger_tool).toBe(0);
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("does not resume a session that moved on after the pause", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
    const stores = memoryStores();
    const c = counts();
    const { approval } = await pause(stores, c);
    vi.setSystemTime(new Date("2026-11-02T20:05:00Z"));
    stores.sessions.update(approval.session_id, [{ role: "user", content: "something else" }]);
    const after = boot(stores, createMockProvider([]), countingVoice(c));

    await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);

    expect(c.danger_tool).toBe(0);
  });

  it("hands a recorded denial to the resumed run as InterruptDeniedError", async () => {
    const stores = memoryStores();
    const c = counts();
    const { approval } = await pause(stores, c);
    const after = boot(stores, createMockProvider([]), countingVoice(c));
    const run = vi.spyOn(after, "run");

    await after.resolveInterrupt(approval.interrupt_id, "denied", { denial_reason: "Too risky" });
    await resumed(after, approval.session_id);

    const outcome = run.mock.results[0]?.value as Promise<unknown>; // Safe: run() always returns a promise.
    await expect(outcome).rejects.toBeInstanceOf(InterruptDeniedError);
    await expect(outcome).rejects.toMatchObject({ reason: "Too risky", interrupt_id: approval.interrupt_id });
  });

  it("leaves the approval pending when a run with durable stores is aborted, and resumes it later", async () => {
    const stores: Stores = { ...memoryStores(), checkpoints: new DurableCheckpoints(), interrupts: new DurableInterrupts() };
    const c = counts();
    const controller = new AbortController();
    const { runtime, run, approval } = await pause(stores, c, controller.signal);

    controller.abort("client went away");
    await expect(run).rejects.toBeInstanceOf(RunAbortedError);
    expect((await stores.interrupts.get(approval.interrupt_id))?.status).toBe("pending");

    await runtime.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(runtime, approval.session_id);
    expect(c.danger_tool).toBe(1);
    expect(stores.sessions.get(approval.session_id)?.messages.at(-1)?.content).toEqual([{ type: "text", text: "done" }]);
  });

  it("still denies an aborted wait on memory stores, as before", async () => {
    const stores = memoryStores();
    const controller = new AbortController();
    const { runtime, run, approval } = await pause(stores, counts(), controller.signal);
    const resolution = nextResolution(runtime);

    controller.abort("client went away");
    await expect(run).rejects.toBeInstanceOf(RunAbortedError);
    expect(await resolution).toEqual({ status: "denied", denial_reason: "run aborted" });
    expect((await stores.interrupts.get(approval.interrupt_id))?.status).toBe("denied");
    expect(await stores.checkpoints.loadLatest(approval.session_id)).toBeNull();
  });

  it("does not start a second run when the paused run is still waiting in this process", async () => {
    const stores = memoryStores();
    const c = counts();
    const { runtime, run, approval } = await pause(stores, c);
    const spy = vi.spyOn(runtime, "run");

    await runtime.resolveInterrupt(approval.interrupt_id, "approved");
    await run;

    expect(spy).not.toHaveBeenCalled();
    expect(c.danger_tool).toBe(1);
  });

  it("keeps a failed pause save from failing the run, and then denies on abort", async () => {
    const checkpoints = new DurableCheckpoints();
    checkpoints.save = () => Promise.reject(new Error("disk full"));
    const stores: Stores = { ...memoryStores(), checkpoints, interrupts: new DurableInterrupts() };
    const controller = new AbortController();
    const { runtime, run, approval } = await pause(stores, counts(), controller.signal);
    const resolution = nextResolution(runtime);

    controller.abort("gone");
    await expect(run).rejects.toBeInstanceOf(RunAbortedError);
    expect((await resolution).status).toBe("denied");
    expect((await stores.interrupts.get(approval.interrupt_id))?.status).toBe("denied");
  });
});
