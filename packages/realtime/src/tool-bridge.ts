/**
 * Bridge between the OpenAI Realtime API's function-call protocol and
 * Tutti's tool / security layer.
 *
 * On register, the supplied tools are advertised to the server via
 * `session.update`. Inbound `response.function_call_arguments.done`
 * events are intercepted and processed through Tutti's security
 * pipeline (permission check, secret redaction, `requireApproval`
 * gating via the {@link InterruptStore}); results are written back
 * with `conversation.item.create` + `response.create`.
 *
 * The bridge mirrors the wiring used by `AgentRunner` so the realtime
 * path goes through the same primitives — there is no parallel
 * security layer.
 */

import {
  PermissionError,
  type EventBus,
  type InterruptRequest,
  type InterruptStore,
} from "@tuttiai/core";
import type { AgentConfig, Permission, Tool } from "@tuttiai/types";

import type { RealtimeClient } from "./client.js";
import { buildToolsSessionUpdate, parseFunctionCallDone } from "./function-codec.js";
import {
  makeResolveInterrupt,
  runCall,
  type ApprovalWaiter,
} from "./tool-call-handler.js";

/** The realtime client opens a WebSocket — `network` is the mandatory grant. */
const REQUIRED_PERMISSIONS: Permission[] = ["network"];

/**
 * Runtime context required by {@link registerTools}. Bundled into one
 * options object so the public API stays close to the spec while still
 * allowing injection of the dependencies a Tutti runtime carries —
 * event bus, interrupt store, session metadata.
 */
export interface RegisterToolsOptions {
  /**
   * Event bus used for `tool:start` / `tool:end` / `tool:error` /
   * `interrupt:requested` / `interrupt:resolved`. The bus auto-redacts
   * payloads via `SecretsManager.redactObject` before fan-out.
   */
  events: EventBus;
  /** Required when `config.requireApproval` may match — pause / resume runs through this store. */
  interruptStore?: InterruptStore;
  /** Active session id — stamped onto every emitted event. */
  session_id: string;
  /** Active agent name — stamped onto every emitted event. */
  agent_name: string;
}

/**
 * Handle returned by {@link registerTools}. `dispose()` detaches every
 * subscription and rejects in-flight approvals so callers can disconnect
 * cleanly without leaking listeners or hanging promises.
 */
export interface RealtimeToolBridge {
  /**
   * Resolve a pending approval. Mirrors `AgentRunner.resolveInterrupt`:
   * approval lets the awaiting tool call execute; denial rejects the
   * awaiter with `InterruptDeniedError` so the outbound result carries
   * an error payload.
   */
  resolveInterrupt(
    interrupt_id: string,
    status: "approved" | "denied",
    options?: { resolved_by?: string; denial_reason?: string },
  ): Promise<InterruptRequest>;
  /** Detach all listeners and reject any in-flight approvals. */
  dispose(): void;
}

/**
 * Wire a tool list into a connected {@link RealtimeClient}, applying
 * Tutti's security pipeline to every server-initiated function call.
 *
 * Tool definitions are advertised on registration *and* whenever the
 * server emits `session.created` (covering reconnect). Returns a
 * `dispose()` handle that detaches every listener.
 *
 * @throws {PermissionError} when `config.permissions` does not grant
 *   `network` — the realtime WebSocket cannot run otherwise.
 */
export function registerTools(
  client: RealtimeClient,
  tools: readonly Tool[],
  config: AgentConfig,
  options: RegisterToolsOptions,
): RealtimeToolBridge {
  enforcePermissions(config.permissions);

  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const pending = new Map<string, ApprovalWaiter>();
  const callCtx = {
    client,
    toolMap,
    config,
    events: options.events,
    ...(options.interruptStore !== undefined ? { interruptStore: options.interruptStore } : {}),
    session_id: options.session_id,
    agent_name: options.agent_name,
    pending,
  };

  const sendDefinitions = (): void => {
    if (!client.isConnected()) return;
    client.send(buildToolsSessionUpdate(tools));
  };
  sendDefinitions();
  const offConnect = client.on("session.created", sendDefinitions);

  const offCall = client.on("response.function_call_arguments.done", (event) => {
    const parsed = parseFunctionCallDone(event);
    if (parsed) void runCall(parsed, callCtx);
  });

  return {
    resolveInterrupt: makeResolveInterrupt(options.events, options.interruptStore, pending),
    dispose: () => {
      offCall();
      offConnect();
      for (const p of pending.values()) {
        p.reject(new Error("RealtimeToolBridge disposed."));
      }
      pending.clear();
    },
  };
}

function enforcePermissions(granted: Permission[] | undefined): void {
  const have = granted ?? [];
  const missing = REQUIRED_PERMISSIONS.filter((p) => !have.includes(p));
  if (missing.length > 0) {
    throw new PermissionError("realtime", REQUIRED_PERMISSIONS, have);
  }
}
