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
 * `requireApproval` config and the tool's own `destructive` flag. Pure
 * helper — exported so consumers can pre-check without constructing a
 * runner.
 *
 * Precedence:
 * 1. `requireApproval: false` — explicit operator opt-out; no gating
 *    even for destructive tools.
 * 2. `destructive: true` on the tool — always gates unless opted out.
 * 3. `requireApproval: "all"` — gates every tool.
 * 4. `requireApproval: string[]` — gates tools whose name matches any
 *    glob in the array.
 * 5. `requireApproval: undefined` with non-destructive tool — no gating.
 */
export function needsApproval(
  config: AgentConfig["requireApproval"],
  tool_name: string,
  destructive?: boolean,
): boolean {
  if (config === false) return false;
  if (destructive === true) return true;
  if (config === undefined) return false;
  if (config === "all") return true;
  return matchesAny(config, tool_name);
}
