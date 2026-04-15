export type {
  InterruptCreateInput,
  InterruptRequest,
  InterruptStatus,
  ResolveOptions,
} from "./types.js";

export type { InterruptStore } from "./store.js";

export { MemoryInterruptStore } from "./memory-store.js";
export {
  PostgresInterruptStore,
  type PostgresInterruptStoreOptions,
} from "./postgres-store.js";

export { globMatch, matchesAny } from "./glob.js";

import type { AgentConfig } from "@tuttiai/types";
import { matchesAny } from "./glob.js";

/**
 * Decide whether a tool call needs operator approval given the agent's
 * `requireApproval` config. Pure helper — exported so consumers can
 * pre-check without constructing a runner.
 */
export function needsApproval(
  config: AgentConfig["requireApproval"],
  tool_name: string,
): boolean {
  if (config === undefined || config === false) return false;
  if (config === "all") return true;
  return matchesAny(config, tool_name);
}
