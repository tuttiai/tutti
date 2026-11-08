import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import { runDelegate, type DelegateDeps } from "./run-delegate.js";

/**
 * The `delegate_to_agent` input schema for a fixed list of specialists.
 *
 * @param delegateIds - Ids the caller may delegate to. Must not be empty.
 * @returns The Zod schema the tool validates its input with.
 */
export function delegateParameters(delegateIds: string[]): z.ZodObject<{
  agent_id: z.ZodEnum<[string, ...string[]]>;
  task: z.ZodString;
}> {
  return z.object({
    agent_id: z
      // Safe: every caller has checked that delegateIds is not empty.
      .enum(delegateIds as [string, ...string[]])
      .describe("Which specialist agent to delegate to"),
    task: z
      .string()
      .describe("The specific task description to pass to the specialist"),
  });
}

/** Validated input of a `delegate_to_agent` call. */
export type DelegateInput = z.infer<ReturnType<typeof delegateParameters>>;

/**
 * Build a `delegate_to_agent` tool that lets `deps.callerId` hand a task to
 * one of `delegateIds` and streams the specialist's output as
 * `delegate:delta` events. Internal to `@tuttiai/core`.
 *
 * @param deps - The router's runtime, score and caller.
 * @param delegateIds - Ids the caller may delegate to. Must not be empty.
 * @returns The tool.
 */
export function buildDelegateTool(deps: DelegateDeps, delegateIds: string[]): Tool<DelegateInput> {
  return {
    name: "delegate_to_agent",
    description:
      "Delegate a task to a specialist agent. The specialist will complete the task and return the result.",
    parameters: delegateParameters(delegateIds),
    execute: (input) => runDelegate(deps, input),
  };
}
