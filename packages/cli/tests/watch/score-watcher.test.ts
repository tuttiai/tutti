import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScoreConfig } from "@tuttiai/types";
import { ReactiveScore } from "../../src/watch/score-watcher.js";

// chokidar is replaced by an in-memory emitter: the unit under test is
// ReactiveScore's debounce and reload plumbing, not filesystem timing.
vi.mock("chokidar", async () => {
  const { EventEmitter } = await import("node:events");
  const watch = vi.fn(() =>
    Object.assign(new EventEmitter(), {
      close: vi.fn(async (): Promise<void> => undefined),
    }),
  );
  return { default: { watch } };
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Absolute path that is never created; the watcher is mocked. */
const scorePath = join(tmpdir(), "tutti-watch", "tutti.score.ts");

/**
 * Minimal synthetic ScoreConfig. We bypass the real `defineScore` +
 * `validateScore` chain by injecting a custom `load` function.
 */
function syntheticScore(systemPrompt: string): ScoreConfig {
  return {
    name: "test-score",
    // Safe: ReactiveScore never touches the provider, it only stores the score.
    provider: {} as ScoreConfig["provider"],
    agents: {
      assistant: {
        name: "assistant",
        system_prompt: systemPrompt,
        voices: [],
      },
    },
  };
}

/** The fake watcher handed to the most recent ReactiveScore. */
function lastWatcher(): FSWatcher {
  const result = vi.mocked(chokidar.watch).mock.results.at(-1);
  if (result?.type !== "return") throw new Error("chokidar.watch was not called");
  return result.value;
}

// ---------------------------------------------------------------------------

describe("ReactiveScore", () => {
  let reactive: ReactiveScore | undefined;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(chokidar.watch).mockClear();
  });

  afterEach(async () => {
    if (reactive) await reactive.close();
    reactive = undefined;
    vi.useRealTimers();
  });

  it("watches the score file and its directory without an initial scan", () => {
    reactive = new ReactiveScore(syntheticScore("v0"), scorePath, {
      load: vi.fn(async (): Promise<ScoreConfig> => syntheticScore("v1")),
    });

    expect(chokidar.watch).toHaveBeenCalledWith(
      [scorePath, dirname(scorePath)],
      expect.objectContaining({ ignoreInitial: true }),
    );
  });

  it("reflects the newly loaded system_prompt after an on-disk edit", async () => {
    let onDisk = "prompt-v1";
    const load = async (): Promise<ScoreConfig> => syntheticScore(onDisk);
    reactive = new ReactiveScore(syntheticScore("prompt-v1"), scorePath, {
      debounceMs: 50,
      load,
    });

    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v1");
    expect(reactive.pendingReload).toBe(false);

    const reloaded = once(reactive, "reloaded");
    onDisk = "prompt-v2";
    lastWatcher().emit("change", scorePath);
    await vi.advanceTimersByTimeAsync(50);
    await reloaded;

    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v2");
    expect(reactive.pendingReload).toBe(true);

    // Callers mark the reload as consumed once they've acted on it.
    reactive.consumePendingReload();
    expect(reactive.pendingReload).toBe(false);
  });

  it("keeps the previous score when the new load throws", async () => {
    // Simulates a syntax error in the user's score file. ReactiveScore
    // does not load on construction, so the change below triggers the
    // first load call.
    const load = async (): Promise<ScoreConfig> => {
      throw new Error("simulated SyntaxError");
    };
    reactive = new ReactiveScore(syntheticScore("prompt-v1"), scorePath, {
      debounceMs: 50,
      load,
    });

    const failure = once(reactive, "reload-failed");
    lastWatcher().emit("change", scorePath);
    await vi.advanceTimersByTimeAsync(50);
    const [err] = await failure;

    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ message: expect.stringMatching(/SyntaxError/) });
    expect(reactive.current.agents.assistant.system_prompt).toBe("prompt-v1");
    expect(reactive.pendingReload).toBe(false);
  });

  it("coalesces rapid consecutive edits into a single reload", async () => {
    let loads = 0;
    const load = vi.fn(async (): Promise<ScoreConfig> => {
      loads += 1;
      return syntheticScore("v" + String(loads));
    });
    reactive = new ReactiveScore(syntheticScore("v0"), scorePath, {
      debounceMs: 100,
      load,
    });

    const reloaded = once(reactive, "reloaded");
    const watcher = lastWatcher();
    watcher.emit("change", scorePath);
    watcher.emit("add", join(dirname(scorePath), "voice.ts"));
    watcher.emit("change", scorePath);

    await vi.advanceTimersByTimeAsync(99);
    expect(load).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await reloaded;
    expect(loads).toBe(1);
  });

  it("close() stops emitting after unrelated subsequent writes", async () => {
    const load = vi.fn(async (): Promise<ScoreConfig> => syntheticScore("x"));
    reactive = new ReactiveScore(syntheticScore("initial"), scorePath, {
      debounceMs: 50,
      load,
    });
    const watcher = lastWatcher();

    await reactive.close();
    const fired = vi.fn();
    reactive.on("reloaded", fired);
    watcher.emit("change", scorePath);
    await vi.runAllTimersAsync();

    expect(watcher.close).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(fired).not.toHaveBeenCalled();
  });
});
