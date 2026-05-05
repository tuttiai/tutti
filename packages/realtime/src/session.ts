/**
 * High-level session that bundles a {@link RealtimeClient} with the
 * {@link registerTools} bridge and surfaces Tutti-shaped lifecycle
 * events on a single typed `on()` channel. Optional checkpoint
 * persistence makes a realtime session show up alongside agent runs in
 * `tutti-ai traces` and Tutti Studio.
 */

import type { Buffer } from "node:buffer";

import {
  EventBus,
  type CheckpointStore,
  type InterruptRequest,
  type InterruptStore,
} from "@tuttiai/core";
import type { AgentConfig, Tool, ToolResult } from "@tuttiai/types";

import { RealtimeClient } from "./client.js";
import { registerTools, type RealtimeToolBridge } from "./tool-bridge.js";
import { TranscriptRecorder } from "./transcript-recorder.js";
import type { RealtimeConfig } from "./types.js";
import type { WebSocketCtor } from "./transport.js";

/** Payloads emitted on each `RealtimeSession` event channel. */
export interface RealtimeSessionEvents {
  audio: { delta: string };
  text: { delta: string };
  transcript: { text: string; role: "user" | "assistant" };
  "tool:call": { tool_name: string; input: unknown };
  "tool:result": { tool_name: string; result: ToolResult };
  interrupt: { interrupt_id: string; tool_name: string; tool_args: unknown };
  error: { error: Error };
  end: { reason: "response.done" | "close" };
}

/** Event name accepted by {@link RealtimeSession.on}. */
export type RealtimeSessionEventName = keyof RealtimeSessionEvents;

/** Construction options for {@link RealtimeSession}. */
export interface RealtimeSessionOptions {
  config: RealtimeConfig;
  tools: readonly Tool[];
  agent: AgentConfig;
  /** Session id stamped on events / checkpoints. Defaults to `'realtime'`. */
  session_id?: string;
  /** Tutti event bus — a fresh one is created when omitted. */
  events?: EventBus;
  /** Required for `requireApproval` flows. */
  interruptStore?: InterruptStore;
  /** Persist transcripts as checkpoints — see {@link TranscriptRecorder}. */
  checkpointStore?: CheckpointStore;
  /** WebSocket constructor injection — tests-only. */
  websocketCtor?: WebSocketCtor;
}

/** Session wrapper — owns the client, bridge, recorder, and dispatcher. */
export class RealtimeSession {
  private readonly client: RealtimeClient;
  private readonly options: RealtimeSessionOptions;
  private readonly events: EventBus;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private bridge: RealtimeToolBridge | null = null;
  private detach: Array<() => void> = [];
  private readonly recorder: TranscriptRecorder | null;
  private readonly sessionId: string;

  constructor(options: RealtimeSessionOptions) {
    this.options = options;
    this.events = options.events ?? new EventBus();
    this.sessionId = options.session_id ?? "realtime";
    const ctor = options.websocketCtor;
    this.client = new RealtimeClient(ctor !== undefined ? { websocketCtor: ctor } : {});
    this.recorder = options.checkpointStore
      ? new TranscriptRecorder({
          store: options.checkpointStore,
          session_id: this.sessionId,
          onError: (err) => this.emit("error", { error: err }),
        })
      : null;
  }

  /** Open the WebSocket, register tools, and start fanning events. */
  async connect(apiKey: string): Promise<void> {
    this.attachClientListeners();
    this.attachBusListeners();
    await this.client.connect(apiKey, this.options.config);
    this.bridge = registerTools(this.client, this.options.tools, this.options.agent, {
      events: this.events,
      ...(this.options.interruptStore !== undefined
        ? { interruptStore: this.options.interruptStore }
        : {}),
      session_id: this.sessionId,
      agent_name: this.options.agent.name,
    });
  }

  /** Subscribe to a session-level event — returns an unsubscribe fn. */
  on<E extends RealtimeSessionEventName>(
    event: E,
    handler: (payload: RealtimeSessionEvents[E]) => void,
  ): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const cast = handler as (payload: unknown) => void;
    set.add(cast);
    return () => {
      const current = this.handlers.get(event);
      if (!current) return;
      current.delete(cast);
      if (current.size === 0) this.handlers.delete(event);
    };
  }

  /** Send 16-bit PCM audio. Throws when not yet connected. */
  sendAudio(buffer: Buffer): void {
    this.client.sendAudio(buffer);
  }

  /** Send a text user message. Throws when not yet connected. */
  sendText(text: string): void {
    this.client.sendText(text);
  }

  /** Resolve a pending approval — forwards to the bridge. */
  resolveInterrupt(
    interrupt_id: string,
    status: "approved" | "denied",
    options: { resolved_by?: string; denial_reason?: string } = {},
  ): Promise<InterruptRequest> {
    if (!this.bridge) throw new Error("RealtimeSession: not connected.");
    return this.bridge.resolveInterrupt(interrupt_id, status, options);
  }

  /** Dispose the bridge, close the client, drop listeners. */
  close(): void {
    this.bridge?.dispose();
    this.bridge = null;
    this.client.disconnect();
    for (const off of this.detach) off();
    this.detach = [];
    this.emit("end", { reason: "close" });
  }

  private attachClientListeners(): void {
    const c = this.client;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    this.detach.push(
      c.on("response.audio.delta", (e) => this.emit("audio", { delta: str(e["delta"]) })),
      c.on("response.text.delta", (e) => this.emit("text", { delta: str(e["delta"]) })),
      c.on("response.audio_transcript.delta", (e) =>
        this.emit("transcript", { text: str(e["delta"]), role: "assistant" }),
      ),
      c.on("conversation.item.input_audio_transcription.completed", (e) =>
        this.emit("transcript", { text: str(e["transcript"]), role: "user" }),
      ),
      c.on("error", (e) =>
        this.emit("error", { error: new Error(str(e["message"]) || "Realtime API error") }),
      ),
      c.on("response.done", () => this.emit("end", { reason: "response.done" })),
    );
  }

  private attachBusListeners(): void {
    this.detach.push(
      this.events.on("tool:start", (e) =>
        this.emit("tool:call", { tool_name: e.tool_name, input: e.input }),
      ),
      this.events.on("tool:end", (e) =>
        this.emit("tool:result", { tool_name: e.tool_name, result: e.result }),
      ),
      this.events.on("tool:error", (e) =>
        this.emit("error", { error: e.error }),
      ),
      this.events.on("interrupt:requested", (e) =>
        this.emit("interrupt", {
          interrupt_id: e.interrupt_id,
          tool_name: e.tool_name,
          tool_args: e.tool_args,
        }),
      ),
    );
  }

  private emit<E extends RealtimeSessionEventName>(
    event: E,
    payload: RealtimeSessionEvents[E],
  ): void {
    if (event === "transcript" && this.recorder) {
      const t = payload as RealtimeSessionEvents["transcript"];
      void this.recorder.record(t.role, t.text);
    }
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) h(payload);
  }
}
