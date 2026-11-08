import { AsyncLocalStorage } from "node:async_hooks";

import type { ToolCallScope } from "./tool-call-scope.js";

/**
 * Where a delegated run sits in a chain of `delegate_to_agent` calls.
 * Internal to `@tuttiai/core`: not exported from the index.
 */
export interface DelegateChain {
  /** Session of the top-level run. */
  root_session_id: string;
  /** Tool call ids from the top-level call down to the current one. */
  path: string[];
  /** Agent ids from the top-level caller down to the current specialist. */
  agents: string[];
}

/**
 * Carries the {@link DelegateChain} through a specialist's run, so a
 * delegation made inside it extends the chain instead of starting a new one.
 */
export const delegateChain = new AsyncLocalStorage<DelegateChain>();

/**
 * The chain a new delegation runs its specialist in: the current chain, or
 * one rooted at the caller's session, extended by this call and target.
 *
 * @param call - The scope of the `delegate_to_agent` call.
 * @param callerId - Id of the agent making the call.
 * @param targetId - Id of the specialist it delegates to.
 * @returns The extended chain.
 */
export function extendChain(
  call: ToolCallScope,
  callerId: string,
  targetId: string,
): DelegateChain {
  const current = delegateChain.getStore();
  return {
    root_session_id: current?.root_session_id ?? call.session_id,
    path: [...(current?.path ?? []), call.tool_call_id],
    agents: [...(current?.agents ?? [callerId]), targetId],
  };
}

/**
 * Whether delegating to `targetId` would re-enter an agent already in the
 * chain (A to B to A), which would loop until the turn limit.
 *
 * @param callerId - Id of the agent making the call.
 * @param targetId - Id of the specialist it delegates to.
 * @returns True when `targetId` is already in the chain.
 */
export function wouldCycle(callerId: string, targetId: string): boolean {
  const agents = delegateChain.getStore()?.agents ?? [callerId];
  return agents.includes(targetId);
}
