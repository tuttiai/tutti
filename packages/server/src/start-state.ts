/**
 * `TUTTI_STATE_DIR`: where the image keeps what must survive a restart.
 *
 * | Path | Holds | Written by |
 * |---|---|---|
 * | `<dir>/sessions/<id>.json` | one conversation each | `FileSessionStore` |
 * | `<dir>/claude-code-sessions.json` | which Claude Code session holds which conversation | `ClaudeCodeProvider`, only for `TUTTI_PROVIDER=claude-code` |
 * | `<dir>/claude/` | the Claude Code CLI's `CLAUDE_CONFIG_DIR`: its session files | the CLI, only for `claude-code` |
 *
 * Set but unusable (it cannot be created or written, as on an older image
 * where `/state` is a root-owned mount point), the server logs a warning and
 * carries on exactly as if it were absent. It never refuses to start over it.
 *
 * Absent or empty, sessions live in memory only, bounded to 1,000 and to 24
 * hours idle, and a restart loses them. The value must be an absolute path.
 * The image creates `/state` owned by its user, so a volume mounted there
 * works as it is.
 *
 * The CLI keeps the sessions it resumes under its own `CLAUDE_CONFIG_DIR`
 * (default `~/.claude`), so without them the registry would point at
 * sessions a restart lost. When the directory is usable and
 * `CLAUDE_CONFIG_DIR` is not already set, the CLI is run with it set to
 * `<dir>/claude`. An unusable directory leaves the CLI's environment as it
 * is, so an image without a writable `/state` behaves exactly as before.
 */

import { accessSync, constants, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { ReadVariable } from "./start-env.js";
import { VoiceConfigError } from "./voice-loader.js";

/** The files under `TUTTI_STATE_DIR`. */
export interface StartStatePaths {
  /** The directory `FileSessionStore` keeps sessions in. */
  readonly sessions: string;
  /** The Claude Code provider's session registry. */
  readonly claude_code_sessions: string;
  /** The Claude Code CLI's config directory, unless `CLAUDE_CONFIG_DIR` already names one. */
  readonly claude_config: string;
}

/**
 * Read `TUTTI_STATE_DIR`.
 *
 * @param read - Reads one variable.
 * @returns The paths under it, or `undefined` when it is unset or empty.
 * @throws {VoiceConfigError} When it is not an absolute path.
 *
 * @example
 * const state = readStartState((key) => SecretsManager.optional(key));
 */
export function readStartState(read: ReadVariable): StartStatePaths | undefined {
  const dir = read("TUTTI_STATE_DIR")?.trim() ?? "";
  if (dir === "") return undefined;
  if (!isAbsolute(dir) || dir.includes("\0")) {
    throw new VoiceConfigError("TUTTI_STATE_DIR must be an absolute path, such as /state.");
  }
  return {
    sessions: join(dir, "sessions"),
    claude_code_sessions: join(dir, "claude-code-sessions.json"),
    claude_config: join(dir, "claude"),
  };
}

/** Reports why a state directory was set aside. `start.ts` passes its logger. */
export type WarnStateUnusable = (context: { dir: string; error: string }, message: string) => void;

/**
 * Check that the state directory can be used: create `sessions` and
 * `claude` under it and confirm all three are writable. A directory that cannot be is set aside, so the
 * server keeps sessions in memory instead of failing to start.
 *
 * @param state - What {@link readStartState} read.
 * @param warn - Told when the directory is set aside.
 * @returns `state` when it is usable, otherwise `undefined`.
 *
 * @example
 * const state = usableStartState(readStartState(read), (ctx, msg) => logger.warn(ctx, msg));
 */
export function usableStartState(
  state: StartStatePaths | undefined,
  warn: WarnStateUnusable,
): StartStatePaths | undefined {
  if (state === undefined) return undefined;
  const dir = join(state.sessions, "..");
  try {
    for (const path of [state.sessions, state.claude_config]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      accessSync(path, constants.W_OK);
    }
    accessSync(dir, constants.W_OK);
    return state;
  } catch (error) {
    warn(
      { dir, error: error instanceof Error ? error.message : String(error) },
      "TUTTI_STATE_DIR cannot be written; keeping sessions in memory, so a restart loses them",
    );
    return undefined;
  }
}
