import { describe, expect, it } from "vitest";
import type { ContentBlock } from "@tuttiai/types";

import { InMemorySessionStore } from "../../src/session-store.js";
import { createMockProvider, textResponse } from "../helpers/mock-provider.js";
import {
  boot,
  countingVoice,
  memoryStores,
  nextApproval,
  resumed,
  toolCalls,
  type Counts,
  type Stores,
} from "./restart-fixture.js";

/** Run until the gate, then "restart": boot a second runtime on the same stores. */
async function pauseThenRestart(stores: Stores, first: ReturnType<typeof toolCalls>[]) {
  const counts: Counts = { safe_tool: 0, danger_tool: 0, slow_tool: 0 };
  const before = boot(stores, createMockProvider(first), countingVoice(counts));
  const paused = nextApproval(before);
  void before.run("worker", "clean up").catch(() => undefined);
  const approval = await paused;
  const provider = createMockProvider([textResponse("done")]);
  const after = boot(stores, provider, countingVoice(counts));
  return { counts, approval, after, provider };
}

function lastContent(stores: Stores, session_id: string): string | ContentBlock[] | undefined {
  return stores.sessions.get(session_id)?.messages.at(-1)?.content;
}

describe("resolving an approval after a restart", () => {
  it("resumes from the pause checkpoint without re-running finished calls", async () => {
    const stores = memoryStores();
    const { counts, approval, after, provider } = await pauseThenRestart(stores, [
      toolCalls("safe_tool"),
      toolCalls("danger_tool"),
    ]);
    expect(await stores.interrupts.listPending()).toHaveLength(1);

    const record = await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);

    expect(record.status).toBe("approved");
    expect(counts).toEqual({ safe_tool: 1, danger_tool: 1, slow_tool: 0 });
    expect(provider.chat).toHaveBeenCalledTimes(1);
    expect(lastContent(stores, approval.session_id)).toEqual([{ type: "text", text: "done" }]);
    expect(await stores.checkpoints.loadLatest(approval.session_id)).toBeNull();
  });

  it("ends the run on a denial without running the gated call", async () => {
    const stores = memoryStores();
    const { counts, approval, after, provider } = await pauseThenRestart(stores, [toolCalls("danger_tool")]);

    const record = await after.resolveInterrupt(approval.interrupt_id, "denied", { denial_reason: "Not on Fridays" });
    await resumed(after, approval.session_id);

    expect(record.denial_reason).toBe("Not on Fridays");
    expect(counts.danger_tool).toBe(0);
    expect(provider.chat).not.toHaveBeenCalled();
    expect(stores.sessions.get(approval.session_id)?.messages).toEqual([]);
    expect(await stores.checkpoints.loadLatest(approval.session_id)).toBeNull();
  });

  it("never re-runs a sibling call cut off by the restart", async () => {
    const stores = memoryStores();
    const { counts, approval, after } = await pauseThenRestart(stores, [toolCalls("slow_tool", "danger_tool")]);

    await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);

    expect(counts).toEqual({ safe_tool: 0, danger_tool: 1, slow_tool: 1 });
    const messages = stores.sessions.get(approval.session_id)?.messages ?? [];
    const results = messages.at(-2)?.content;
    expect(results).toEqual([
      expect.objectContaining({ tool_use_id: "call-slow_tool-0", is_error: true, content: expect.stringContaining("interrupted by restart") }),
      expect.objectContaining({ tool_use_id: "call-danger_tool-1" }),
    ]);
  });

  it("does nothing more on a second resolve of the same approval", async () => {
    const stores = memoryStores();
    const { counts, approval, after, provider } = await pauseThenRestart(stores, [toolCalls("danger_tool")]);

    const first = await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);
    const second = await after.resolveInterrupt(approval.interrupt_id, "denied");
    await resumed(after, approval.session_id);

    expect(second).toEqual(first);
    expect(counts.danger_tool).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("resumes once when two approvals of the same call race", async () => {
    const stores = memoryStores();
    const { counts, approval, after, provider } = await pauseThenRestart(stores, [toolCalls("danger_tool")]);

    await Promise.all([
      after.resolveInterrupt(approval.interrupt_id, "approved"),
      after.resolveInterrupt(approval.interrupt_id, "approved"),
    ]);
    await resumed(after, approval.session_id);

    expect(counts.danger_tool).toBe(1);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("rebuilds a session the restart lost and finishes the run into it", async () => {
    const stores = memoryStores();
    const { counts, approval } = await pauseThenRestart(stores, [toolCalls("danger_tool")]);
    const fresh: Stores = { ...stores, sessions: new InMemorySessionStore() };
    const after = boot(fresh, createMockProvider([textResponse("done")]), countingVoice(counts));

    await after.resolveInterrupt(approval.interrupt_id, "approved");
    await resumed(after, approval.session_id);

    expect(counts.danger_tool).toBe(1);
    expect(lastContent(fresh, approval.session_id)).toEqual([{ type: "text", text: "done" }]);
  });
});
