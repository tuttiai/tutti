import { describe, expect, it } from "vitest";

import {
  dropWaiter,
  hasWaiter,
  noteWaiter,
  queueReplay,
  resumeInFlight,
  resumeOnce,
  takeReplay,
} from "../../src/interrupt/live-waiters.js";
import type { PausedTurn } from "../../src/interrupt/pause.js";

function pausedTurn(session_id: string): PausedTurn {
  return {
    session_id,
    turn: 1,
    messages: [],
    response: { id: "", content: [], stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } },
    dispositions: new Map(),
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

describe("live waiters", () => {
  it("tracks waiters per owner", () => {
    const a = {};
    const b = {};
    noteWaiter(a, "i1");
    expect(hasWaiter(a, "i1")).toBe(true);
    expect(hasWaiter(b, "i1")).toBe(false);
    dropWaiter(a, "i1");
    expect(hasWaiter(a, "i1")).toBe(false);
    dropWaiter(b, "never-noted");
  });

  it("hands a queued replay over exactly once", () => {
    const owner = {};
    const turn = pausedTurn("s1");
    queueReplay(owner, turn);
    expect(takeReplay(owner, "s2")).toBeUndefined();
    expect(takeReplay(owner, "s1")).toBe(turn);
    expect(takeReplay(owner, "s1")).toBeUndefined();
    expect(takeReplay({}, "s1")).toBeUndefined();
  });

  it("runs one resume per session at a time and forgets it once done", async () => {
    const owner = {};
    let release = (): void => undefined;
    let starts = 0;
    const work = (): Promise<void> => {
      starts++;
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const first = resumeOnce(owner, "s1", work);
    const second = resumeOnce(owner, "s1", work);
    expect(second).toBe(first);
    expect(resumeInFlight(owner, "s1")).toBe(first);
    expect(starts).toBe(1);
    release();
    await first;
    expect(resumeInFlight(owner, "s1")).toBeUndefined();
    expect(resumeInFlight({}, "s1")).toBeUndefined();
  });
});
