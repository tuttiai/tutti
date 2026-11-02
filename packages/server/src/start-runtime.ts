/**
 * The pure half of `start.ts`: turning what the environment says into the
 * one agent and the runtime that runs it. Kept apart so it can be tested
 * without starting a process.
 */

import {
  FileSessionStore,
  InMemorySessionStore,
  TuttiRuntime,
  createLogger,
} from "@tuttiai/core";
import type { SessionStore } from "@tuttiai/types";
import type { AgentConfig, ScoreConfig, Voice } from "@tuttiai/types";

import type { StartAgentEnv } from "./start-env.js";
import type { StartStatePaths } from "./start-state.js";
import { memoryStartStores, type StartStores } from "./start-stores.js";

/** The agent fields `start.ts` reads from its own variables. */
export interface StartAgentBase {
  readonly name: string;
  readonly model: string;
  readonly system_prompt: string;
}

/**
 * Build the image's one agent.
 *
 * @param base - Name, model and system prompt.
 * @param env - What `readStartAgentEnv` read.
 * @param voices - The loaded voices, already checked against the permissions.
 * @returns A streaming agent carrying the limits and approval policy that were set.
 *
 * @example
 * const agent = buildStartAgent({ name, model, system_prompt }, env, voices);
 */
export function buildStartAgent(
  base: StartAgentBase,
  env: StartAgentEnv,
  voices: Voice[],
): AgentConfig {
  const agent: AgentConfig = {
    ...base,
    voices,
    permissions: [...env.permissions],
    streaming: true,
  };
  if (env.max_turns !== undefined) agent.max_turns = env.max_turns;
  if (env.max_tool_calls !== undefined) agent.max_tool_calls = env.max_tool_calls;
  if (env.max_cost_usd !== undefined) agent.budget = { max_cost_usd: env.max_cost_usd };
  if (env.tool_timeout_ms !== undefined) agent.tool_timeout_ms = env.tool_timeout_ms;
  if (env.require_approval !== undefined) agent.requireApproval = env.require_approval;
  if (env.context !== undefined) agent.context = env.context;
  return agent;
}

/**
 * Build the runtime for the image's score.
 *
 * @remarks
 * It always carries an interrupt store. Without one, a tool the framework
 * gates by default (any marked `destructive`) throws when called, and the
 * approve and deny routes answer 503. Which store is `start-stores.ts`'s
 * choice: with Postgres or a state directory, approvals and the turns their
 * runs paused at survive a restart, and approving afterwards resumes the
 * run. Left to the default, they live in memory and a restart forgets them.
 *
 * Given `TUTTI_STATE_DIR`'s paths, sessions are kept in a
 * {@link FileSessionStore} there and survive a restart. Without them they
 * live in a bounded in-memory store, as they do too when the file store
 * cannot open its directory: that is logged, never fatal.
 *
 * @param score - The one-agent score.
 * @param state - The paths `readStartState` read, or `undefined` to keep sessions in memory.
 * @param stores - What `buildStartStores` chose. Defaults to memory.
 * @returns A runtime whose gated tool calls pause for a person.
 *
 * @example
 * const runtime = buildStartRuntime(score, state, buildStartStores(pgUrl, state, warn));
 */
export function buildStartRuntime(
  score: ScoreConfig,
  state?: StartStatePaths,
  stores: StartStores = memoryStartStores(),
): TuttiRuntime {
  return new TuttiRuntime(score, {
    interruptStore: stores.interrupts,
    ...(stores.checkpoints !== undefined ? { checkpointStore: stores.checkpoints } : {}),
    sessionStore: buildSessionStore(state),
  });
}

function buildSessionStore(state: StartStatePaths | undefined): SessionStore {
  if (state === undefined) return new InMemorySessionStore();
  try {
    return new FileSessionStore(state.sessions);
  } catch (error) {
    createLogger("tutti-server").warn(
      { dir: state.sessions, error: error instanceof Error ? error.message : String(error) },
      "Cannot keep sessions on disk; keeping them in memory, so a restart loses them",
    );
    return new InMemorySessionStore();
  }
}
