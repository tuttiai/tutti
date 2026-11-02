/**
 * Process-local bookkeeping for approvals, kept off `AgentRunner`'s public
 * surface: which approvals still have a run waiting on them here, which
 * paused turns a runner should replay on its next run of a session, and
 * which sessions are being resumed right now.
 *
 * State is keyed by the owning runner, so two runtimes in one process never
 * see each other's waiters. The `owner` is typed `object` to avoid an import
 * cycle with `agent-runner.ts`.
 *
 * @module
 */

import type { PausedTurn } from "./pause.js";

const waiters = new WeakMap<object, Set<string>>();
const replays = new WeakMap<object, Map<string, PausedTurn>>();
const resuming = new WeakMap<object, Map<string, Promise<void>>>();

function bucket<V>(map: WeakMap<object, V>, owner: object, create: () => V): V {
  let value = map.get(owner);
  if (value === undefined) {
    value = create();
    map.set(owner, value);
  }
  return value;
}

/**
 * Record that a run in this process waits on an approval.
 *
 * @param owner - The runner holding the waiter.
 * @param interrupt_id - The approval's id.
 */
export function noteWaiter(owner: object, interrupt_id: string): void {
  bucket(waiters, owner, () => new Set<string>()).add(interrupt_id);
}

/**
 * Forget a waiter, once it is resolved or its run gave up.
 *
 * @param owner - The runner that held the waiter.
 * @param interrupt_id - The approval's id.
 */
export function dropWaiter(owner: object, interrupt_id: string): void {
  waiters.get(owner)?.delete(interrupt_id);
}

/**
 * Whether a run in this process still waits on an approval.
 *
 * @param owner - The runner to ask about.
 * @param interrupt_id - The approval's id.
 * @returns `true` when resolving it reaches a live run.
 */
export function hasWaiter(owner: object, interrupt_id: string): boolean {
  return waiters.get(owner)?.has(interrupt_id) === true;
}

/**
 * Hand a paused turn to the runner's next run of its session.
 *
 * @param owner - The runner that will replay it.
 * @param turn - The planned turn.
 */
export function queueReplay(owner: object, turn: PausedTurn): void {
  bucket(replays, owner, () => new Map<string, PausedTurn>()).set(turn.session_id, turn);
}

/**
 * Take the paused turn queued for a session, once.
 *
 * @param owner - The runner starting a run.
 * @param session_id - The run's session.
 * @returns The turn to replay, or `undefined` for an ordinary run.
 */
export function takeReplay(owner: object, session_id: string): PausedTurn | undefined {
  const map = replays.get(owner);
  const turn = map?.get(session_id);
  map?.delete(session_id);
  return turn;
}

/**
 * Run `work` as the one resume of a session in this process. A second call
 * for the same session while the first is running gets the first's promise
 * and starts nothing.
 *
 * @param owner - The runner the resume belongs to.
 * @param session_id - The session being resumed.
 * @param work - Starts the resume. It must not reject.
 * @returns The resume in flight.
 */
export function resumeOnce(owner: object, session_id: string, work: () => Promise<void>): Promise<void> {
  const map = bucket(resuming, owner, () => new Map<string, Promise<void>>());
  const running = map.get(session_id);
  if (running) return running;
  const started = work().finally(() => map.delete(session_id));
  map.set(session_id, started);
  return started;
}

/**
 * The resume in flight for a session, if any. Lets tests and shutdown code
 * wait for a background resume without a timer.
 *
 * @param owner - The runner the resume belongs to.
 * @param session_id - The session.
 * @returns The resume's promise, or `undefined` when none is running.
 */
export function resumeInFlight(owner: object, session_id: string): Promise<void> | undefined {
  return resuming.get(owner)?.get(session_id);
}
