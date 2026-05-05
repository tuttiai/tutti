/**
 * Persists realtime transcripts as checkpoints so they show up alongside
 * regular agent runs in `tutti-ai traces` and Tutti Studio.
 *
 * Each user / assistant utterance becomes one new {@link Checkpoint}
 * with the running messages array appended and `turn` incremented. The
 * checkpoint shape is identical to what `AgentRunner` writes — readers
 * downstream don't need to special-case realtime sessions.
 *
 * Errors from the store are caught and routed through a callback so a
 * misbehaving backend never tears down a live audio session.
 */

import type { Checkpoint, CheckpointStore } from "@tuttiai/core";
import type { ChatMessage } from "@tuttiai/types";

/** Optional callback invoked on persistence errors. */
export type RecorderErrorHandler = (err: Error) => void;

/** Construction inputs for a {@link TranscriptRecorder}. */
export interface TranscriptRecorderOptions {
  store: CheckpointStore;
  session_id: string;
  /** Called when a save fails. Defaults to a silent drop. */
  onError?: RecorderErrorHandler;
}

/** Initial counter values for state fields the realtime path doesn't fill. */
const ZERO_USAGE = {
  next_turn: 0,
  prompt_tokens_used: 0,
  completion_tokens_used: 0,
} as const;

/**
 * Append-only writer for the running transcript of one realtime session.
 *
 * Owns the in-memory `messages` array and the `turn` counter so the
 * caller (RealtimeSession) doesn't have to track checkpoint state
 * itself. Concurrent calls are serialised on the internal write
 * promise to keep the on-disk turn order monotonic.
 */
export class TranscriptRecorder {
  private readonly store: CheckpointStore;
  private readonly session_id: string;
  private readonly onError: RecorderErrorHandler;
  private messages: ChatMessage[] = [];
  private turn = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: TranscriptRecorderOptions) {
    this.store = options.store;
    this.session_id = options.session_id;
    this.onError = options.onError ?? noop;
  }

  /**
   * Append one utterance and persist a fresh checkpoint. Returns when
   * the underlying store call settles; safe to fire-and-forget — saves
   * are chained internally so order is preserved either way.
   */
  record(role: "user" | "assistant", text: string): Promise<void> {
    if (text.length === 0) return Promise.resolve();
    this.messages.push({ role, content: text });
    const turn = this.turn;
    this.turn += 1;
    const messagesSnapshot = this.messages.slice();
    this.chain = this.chain.then(() =>
      this.persist(turn, messagesSnapshot).catch((err: unknown) =>
        this.onError(err instanceof Error ? err : new Error(String(err))),
      ),
    );
    return this.chain;
  }

  /** Snapshot of the in-memory transcript. Useful for tests / introspection. */
  snapshot(): readonly ChatMessage[] {
    return this.messages.slice();
  }

  private persist(turn: number, messages: ChatMessage[]): Promise<void> {
    const checkpoint: Checkpoint = {
      session_id: this.session_id,
      turn,
      messages,
      tool_results: [],
      state: { ...ZERO_USAGE, next_turn: turn + 1 },
      saved_at: new Date(),
    };
    return this.store.save(checkpoint);
  }
}

function noop(): void {
  // intentionally empty — default error sink for fire-and-forget callers.
}
