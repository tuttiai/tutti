/**
 * Finishing a paused run after the process that paused it is gone.
 *
 * `TuttiRuntime.resolveInterrupt` calls {@link resumePausedRun} when an
 * approval moves out of `"pending"` and no run in this process waits on it.
 * It reads the pause checkpoint, plans the turn, and when every call of the
 * turn is decided starts an ordinary run of the session, which replays the
 * turn instead of calling the model. That run goes through `TuttiRuntime.run`,
 * so voice permissions are checked exactly as for any other run.
 *
 * Nothing here throws: every outcome is logged, and the approval itself was
 * recorded before this starts.
 *
 * @module
 */

import type { Session, SessionStore } from "@tuttiai/types";

import type { CheckpointStore } from "../checkpoint/store.js";
import type { Checkpoint } from "../checkpoint/types.js";
import { InterruptDeniedError } from "../errors.js";
import { FileSessionStore } from "../file-session-store.js";
import { logger } from "../logger.js";
import { InMemorySessionStore } from "../session-store.js";
import { queueReplay, resumeOnce } from "./live-waiters.js";
import { isPauseCheckpoint, planResume } from "./pause.js";
import type { InterruptStore } from "./store.js";
import type { InterruptRequest } from "./types.js";

/** What {@link resumePausedRun} needs from the runtime. */
export interface ResumeDeps {
  /** The runner that will replay the turn; keys the process-local state. */
  owner: object;
  sessions: SessionStore;
  checkpoints: CheckpointStore | undefined;
  interrupts: InterruptStore;
  /** The score's agent names, to recover a lost session's agent when there is only one. */
  agents: string[];
  /** Starts a run of the session, as `TuttiRuntime.run(agent, "", session_id)`. */
  run: (agent_name: string, session_id: string) => Promise<unknown>;
}

/**
 * Resume the run paused on `record`, if it can be, once per session at a time.
 *
 * @param deps - The runtime's stores and a way to start a run.
 * @param record - The approval just resolved.
 * @returns Resolves when the resume has finished or been set aside. Never rejects.
 */
export function resumePausedRun(deps: ResumeDeps, record: InterruptRequest): Promise<void> {
  const log = { session: record.session_id, interrupt_id: record.interrupt_id };
  return resumeOnce(deps.owner, record.session_id, () =>
    attempt(deps, record).catch((err: unknown) => {
      if (err instanceof InterruptDeniedError) {
        logger.info(log, "Resumed run ended by the recorded denial");
        return;
      }
      logger.error({ ...log, error: err instanceof Error ? err.message : String(err) }, "Resumed run failed");
    }),
  );
}

async function attempt(deps: ResumeDeps, record: InterruptRequest): Promise<void> {
  const log = { session: record.session_id, interrupt_id: record.interrupt_id };
  const cp = await deps.checkpoints?.loadLatest(record.session_id);
  if (!cp || !isPauseCheckpoint(cp)) {
    logger.warn(log, "Approval recorded, but the run could not resume: its pause checkpoint is missing or has expired");
    return;
  }
  const agent = await sessionAgent(deps, cp);
  if (agent === undefined) return;
  const plan = planResume(cp, await deps.interrupts.listBySession(record.session_id));
  if (plan.kind === "wait") {
    logger.info(log, "Approval recorded; the run resumes once its other pending approvals are resolved");
    return;
  }
  if (plan.kind === "invalid") {
    logger.warn(log, "Approval recorded, but the run could not resume: its pause checkpoint cannot be read");
    return;
  }
  logger.info({ ...log, turn: cp.turn }, "Resuming a paused run from its pause checkpoint");
  queueReplay(deps.owner, plan.turn);
  await deps.run(agent, record.session_id);
}

/**
 * The agent to resume the session with, or `undefined` (logged) when it must
 * not be resumed: the session moved on past the paused turn, or it was lost
 * and cannot be rebuilt.
 */
async function sessionAgent(deps: ResumeDeps, cp: Checkpoint): Promise<string | undefined> {
  const log = { session: cp.session_id, turn: cp.turn };
  const session = deps.sessions.get(cp.session_id) ?? (await deps.sessions.load?.(cp.session_id));
  if (session) {
    if (session.updated_at.getTime() <= cp.saved_at.getTime()) return session.agent_name;
    logger.info(log, "Approval recorded; the run is not resumed because its session has moved on since it paused");
    return undefined;
  }
  const [only, ...others] = deps.agents;
  if (only !== undefined && others.length === 0 && rebuild(deps.sessions, cp, only)) return only;
  logger.warn(log, "Approval recorded, but the run could not resume: its session is gone and cannot be rebuilt");
  return undefined;
}

/**
 * Put a lost session back under its id, empty, so the resumed run can write
 * to it: the run starts from the checkpoint's history and stores it all. Only the stores that accept a
 * caller-chosen id can; the `SessionStore` interface is not widened for it.
 */
function rebuild(store: SessionStore, cp: Checkpoint, agent_name: string): boolean {
  if (!(store instanceof InMemorySessionStore) && !(store instanceof FileSessionStore)) return false;
  const at = new Date(cp.saved_at.getTime());
  const session: Session = { id: cp.session_id, agent_name, messages: [], created_at: at, updated_at: at };
  store.save(session);
  return true;
}
