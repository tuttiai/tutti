/**
 * Run preflight — the checks and resolution that happen before a run is
 * traced, and before any turn is attempted.
 *
 * Both functions here fail fast: an invalid configuration or a missing session
 * surfaces at run start rather than partway through a turn, when tokens have
 * already been spent.
 */

import type { AgentConfig, Session, SessionStore } from "@tuttiai/types";
import type { AgentRunOptions } from "../memory/user/types.js";

/**
 * Reject `model: "auto"` when the score's provider cannot route.
 *
 * `model: "auto"` opts an agent into per-call routing via the score's
 * `SmartProvider`. Falling back silently to a default model would give the
 * caller none of the cost optimisation they asked for and no indication why,
 * so this throws instead.
 *
 * @param agent - The agent about to run.
 * @param hasSmartProvider - Whether the configured provider exposes the SmartProvider surface.
 * @throws {Error} When the agent requests `"auto"` without a SmartProvider.
 */
export function assertAutoModelSupported(agent: AgentConfig, hasSmartProvider: boolean): void {
  if (agent.model === "auto" && !hasSmartProvider) {
    throw new Error(
      `Agent "${agent.name}" sets model: 'auto' but the score's provider is not a SmartProvider.\n` +
        `Configure a SmartProvider from @tuttiai/router on your score, or set an explicit model on the agent.`,
    );
  }
}

/** The session identity resolved for a run. */
export interface ResolvedRunSession {
  /** The live session, either fetched by id or freshly created. */
  session: Session;
  /** The id the caller asked to resume, if any. */
  resolvedSessionId: string | undefined;
  /** The user this run is attributed to, if any. */
  userId: string | undefined;
}

/**
 * Resolve the session a run executes against, creating one when the caller did
 * not name an existing conversation.
 *
 * `session_id` may arrive either positionally (legacy) or in the options bag;
 * the positional argument wins on conflict for back-compatibility.
 *
 * @param agent - The agent about to run.
 * @param session_id - The positional session id, if the caller passed one.
 * @param options - The run options bag, which may also carry `session_id` and `user_id`.
 * @param sessions - The store to resolve against.
 * @returns The resolved session plus the ids derived alongside it.
 * @throws {Error} When a named session cannot be found.
 */
export function resolveRunSession(
  agent: AgentConfig,
  session_id: string | undefined,
  options: AgentRunOptions | undefined,
  sessions: SessionStore,
): ResolvedRunSession {
  const resolvedSessionId = session_id ?? options?.session_id;
  const userId = options?.user_id;

  const session = resolvedSessionId
    ? sessions.get(resolvedSessionId)
    : sessions.create(agent.name);

  if (!session) {
    throw new Error(
      `Session not found: ${resolvedSessionId}\n` +
      `The session may have expired or the ID is incorrect.\n` +
      `Omit session_id to start a new conversation.`,
    );
  }

  return { session, resolvedSessionId, userId };
}
