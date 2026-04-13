import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScoreConfig } from "@tuttiai/types";
import { ReactiveScore } from "../../src/watch/score-watcher.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal synthetic ScoreConfig. We bypass the real `defineScore` +
 * `validateScore` chain by injecting a custom `load` function; the unit
 * under test is ReactiveScore's file-watching + reload plumbing, not the
 * score-file validator.
 */
function syntheticScore(systemPrompt: string): ScoreConfig {
  return {
    name: "test-score",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture
    provider: {} as any,
    agents: {
      assistant: {
        name: "assistant",
        system_prompt: systemPrompt,
        voices: [],
      },
    },
  } as ScoreConfig;
}

/** Wait for the next `n` events of a given name, or timeout. */
function waitForEvent(
  emitter: ReactiveScore,
  event: string,
  timeoutMs = 2000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, handler);
      reject(new Error("timeout waiting for event: " + event));
    }, timeoutMs);
    const handler = (...args: unknown[]): void => {
      clearTimeout(timer);
      resolve(args);
    };
    emitter.once(event, handler);
  });
}

// ---------------------------------------------------------------------------

describe("ReactiveScore", () => {
  let workDir: string;
  let scorePath: string;
  let reactive: ReactiveScore | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tutti-watch-"));
    scorePath = join(workDir, "tutti.score.ts");
    await writeFile(scorePath, "prompt-v1");
  });

  afterEach(async () => {
    if (reactive) await reactive.close();
    reactive = undefined;
    await rm(workDir, { recursive: true, force: true });
  });

  it("reflects the newly loaded system_prompt after an on-disk edit", async () => {
    // Custom loader reads the file contents and turns them into a score —
    // lets us change the prompt just by rewriting the file.
    const load = async (path: string): Promise<ScoreConfig> => {
      const { readFile } = await import("node:fs/promises");
      const text = (await readFile(path, "utf-8")).trim();
      return syntheticScore(text);
    };

    reactive = new ReactiveScore(syntheticScore("prompt-v1"), scorePath, {
      debounceMs: 50,
      load,
    });

    // Baseline: current returns the initial score, no reload pending.
    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v1");
    expect(reactive.pendingReload).toBe(false);

    // Edit the file — the watcher should debounce, reload, and emit.
    const reloaded = waitForEvent(reactive, "reloaded");
    await writeFile(scorePath, "prompt-v2");
    await reloaded;

    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v2");
    expect(reactive.pendingReload).toBe(true);

    // Callers mark the reload as consumed once they've acted on it.
    reactive.consumePendingReload();
    expect(reactive.pendingReload).toBe(false);
  });

  it("keeps the previous score when the new load throws", async () => {
    // Every load throws — simulates a syntax error in the user's score
    // file when the watcher picks up the change. ReactiveScore doesn't
    // load on construction (the initial score is passed in), so the
    // first load call happens *because* of the file change we make below.
    const load = async (_: string): Promise<ScoreConfig> => {
      throw new Error("simulated SyntaxError");
    };

    reactive = new ReactiveScore(syntheticScore("prompt-v1"), scorePath, {
      debounceMs: 50,
      load,
    });

    const failure = waitForEvent(reactive, "reload-failed");
    await writeFile(scorePath, "anything");
    const [err] = (await failure) as [Error];

    expect(err.message).toMatch(/SyntaxError/);
    // `current` still points at the last-known-good score.
    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v1");
    expect(reactive.pendingReload).toBe(false);
  });

  it("coalesces rapid consecutive edits into a single reload", async () => {
    let loads = 0;
    const load = async (): Promise<ScoreConfig> => {
      loads += 1;
      return syntheticScore("v" + loads);
    };

    reactive = new ReactiveScore(syntheticScore("v0"), scorePath, {
      debounceMs: 100,
      load,
    });

    const reloaded = waitForEvent(reactive, "reloaded");

    // Three writes in quick succession — the debounce should collapse
    // them into one actual reload call.
    await writeFile(scorePath, "edit 1");
    await writeFile(scorePath, "edit 2");
    await writeFile(scorePath, "edit 3");

    await reloaded;
    expect(loads).toBe(1);
  });

  it("close() stops emitting after unrelated subsequent writes", async () => {
    const load = async (): Promise<ScoreConfig> => syntheticScore("anything");

    reactive = new ReactiveScore(syntheticScore("initial"), scorePath, {
      debounceMs: 50,
      load,
    });

    await reactive.close();

    let fired = false;
    reactive.on("reloaded", () => {
      fired = true;
    });

    await writeFile(scorePath, "post-close");
    // Give the fs some time — no event should fire since we've closed.
    await new Promise((r) => setTimeout(r, 150));
    expect(fired).toBe(false);
  });
});
