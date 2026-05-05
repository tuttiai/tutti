/**
 * Internal helpers for `tool-bridge.ts` — running a single intercepted
 * function call through Tutti's security pipeline (redaction, approval
 * gating, execution) and writing the result back to the realtime
 * socket. Split from `tool-bridge.ts` solely to keep each file under
 * the 200-line ceiling; not part of the public API.
 */

import {
  InterruptDeniedError,
  SecretsManager,
  needsApproval,
  type EventBus,
  type InterruptRequest,
  type InterruptStore,
} from "@tuttiai/core";
import type { AgentConfig, Tool, ToolContext, ToolResult } from "@tuttiai/types";

import type { RealtimeClient } from "./client.js";
import {
  buildFunctionCallOutput,
  buildResponseCreate,
  type RealtimeFunctionCall,
} from "./function-codec.js";

/** Resolver for a single in-flight approval, keyed by interrupt id. */
export interface ApprovalWaiter {
  resolve(req: InterruptRequest): void;
  reject(err: Error): void;
}

/** Inputs threaded through the call-handler pipeline. */
export interface ToolCallContext {
  client: RealtimeClient;
  toolMap: Map<string, Tool>;
  config: AgentConfig;
  events: EventBus;
  interruptStore?: InterruptStore;
  session_id: string;
  agent_name: string;
  pending: Map<string, ApprovalWaiter>;
}

/**
 * Process one inbound function call: redact, optionally gate via
 * approval, execute, emit telemetry, and return the result on the wire.
 * Errors never propagate — they're caught, redacted, and surfaced to
 * the model as a plaintext error message so the conversation continues.
 */
export async function runCall(
  call: RealtimeFunctionCall,
  ctx: ToolCallContext,
): Promise<void> {
  const tool = ctx.toolMap.get(call.name);
  if (!tool) {
    sendResult(ctx.client, call.call_id, errorResult(`Unknown tool: ${call.name}`));
    return;
  }
  const safeArgs = SecretsManager.redactObject(call.arguments);
  ctx.events.emit({
    type: "tool:start",
    agent_name: ctx.agent_name,
    tool_name: tool.name,
    input: safeArgs,
  });

  try {
    if (needsApproval(ctx.config.requireApproval, tool.name, tool.destructive)) {
      await awaitApproval(tool.name, safeArgs, ctx);
    }
    const result = await executeTool(tool, call.arguments, ctx);
    ctx.events.emit({
      type: "tool:end",
      agent_name: ctx.agent_name,
      tool_name: tool.name,
      result,
    });
    sendResult(ctx.client, call.call_id, result.content);
  } catch (err) {
    const message = SecretsManager.redact(err instanceof Error ? err.message : String(err));
    ctx.events.emit({
      type: "tool:error",
      agent_name: ctx.agent_name,
      tool_name: tool.name,
      error: err instanceof Error ? err : new Error(message),
    });
    sendResult(ctx.client, call.call_id, message);
  }
}

async function executeTool(
  tool: Tool,
  args: unknown,
  ctx: ToolCallContext,
): Promise<ToolResult> {
  const parsed = tool.parameters.parse(args);
  const toolCtx: ToolContext = {
    session_id: ctx.session_id,
    agent_name: ctx.agent_name,
  };
  return tool.execute(parsed, toolCtx);
}

function awaitApproval(
  tool_name: string,
  redactedArgs: unknown,
  ctx: ToolCallContext,
): Promise<InterruptRequest> {
  if (!ctx.interruptStore) {
    return Promise.reject(
      new Error(
        `Tool "${tool_name}" matched requireApproval but no InterruptStore was configured.`,
      ),
    );
  }
  return ctx.interruptStore
    .create({ session_id: ctx.session_id, tool_name, tool_args: redactedArgs })
    .then(
      (req) =>
        new Promise<InterruptRequest>((resolve, reject) => {
          ctx.pending.set(req.interrupt_id, { resolve, reject });
          ctx.events.emit({
            type: "interrupt:requested",
            session_id: ctx.session_id,
            tool_name,
            interrupt_id: req.interrupt_id,
            tool_args: redactedArgs,
          });
        }),
    );
}

/** Build the resolver function exposed on the bridge handle. */
export function makeResolveInterrupt(
  events: EventBus,
  interruptStore: InterruptStore | undefined,
  pending: Map<string, ApprovalWaiter>,
): (
  interrupt_id: string,
  status: "approved" | "denied",
  options?: { resolved_by?: string; denial_reason?: string },
) => Promise<InterruptRequest> {
  return async (interrupt_id, status, resolveOpts = {}) => {
    if (!interruptStore) {
      throw new Error("resolveInterrupt: no InterruptStore is configured.");
    }
    const resolved = await interruptStore.resolve(interrupt_id, status, resolveOpts);
    const waiter = pending.get(interrupt_id);
    if (waiter) {
      pending.delete(interrupt_id);
      if (resolved.status === "approved") waiter.resolve(resolved);
      else
        waiter.reject(
          new InterruptDeniedError(
            resolved.tool_name,
            resolved.denial_reason ?? "denied",
            resolved.interrupt_id,
          ),
        );
    }
    events.emit({
      type: "interrupt:resolved",
      session_id: resolved.session_id,
      tool_name: resolved.tool_name,
      interrupt_id: resolved.interrupt_id,
      status: resolved.status as "approved" | "denied",
      ...(resolved.denial_reason !== undefined ? { denial_reason: resolved.denial_reason } : {}),
      ...(resolved.resolved_by !== undefined ? { resolved_by: resolved.resolved_by } : {}),
    });
    return resolved;
  };
}

function errorResult(message: string): string {
  return JSON.stringify({ error: message });
}

function sendResult(client: RealtimeClient, call_id: string, content: string): void {
  client.send(buildFunctionCallOutput(call_id, content));
  client.send(buildResponseCreate());
}
