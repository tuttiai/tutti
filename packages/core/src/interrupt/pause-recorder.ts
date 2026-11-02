/**
 * Saving a turn's pause checkpoint while its tool calls run, and the
 * per-call decisions a replayed turn carries into `executeTool`.
 *
 * Both are looked up by the `tool_use` block object, which the runner
 * passes to `executeTool` unchanged, so no runner signature grows.
 *
 * @module
 */

import type { ChatMessage, TokenUsage, ToolResultBlock, ToolUseBlock } from "@tuttiai/types";

import { MemoryCheckpointStore } from "../checkpoint/memory.js";
import type { CheckpointStore } from "../checkpoint/store.js";
import { InterruptDeniedError } from "../errors.js";
import { logger } from "../logger.js";
import { MemoryInterruptStore } from "./memory-store.js";
import { buildPauseCheckpoint, type Disposition, type PausedTurn } from "./pause.js";
import type { InterruptStore } from "./store.js";

const recorders = new WeakMap<ToolUseBlock, PauseRecorder>();
const decisions = new WeakMap<ToolUseBlock, Disposition>();

/**
 * Whether both stores outlive the process, so a paused run can be finished
 * by another one. Memory stores cannot.
 *
 * @param checkpoints - The runner's checkpoint store.
 * @param interrupts - The runner's interrupt store.
 * @returns `true` when neither is an in-memory store.
 */
export function storesAreDurable(checkpoints: CheckpointStore, interrupts: InterruptStore): boolean {
  return !(checkpoints instanceof MemoryCheckpointStore) && !(interrupts instanceof MemoryInterruptStore);
}

/** The turn a {@link PauseRecorder} watches. */
export interface PauseTurn {
  session_id: string;
  turn: number;
  /** History up to and including the assistant's `tool_use` message. */
  messages: ChatMessage[];
  usage: TokenUsage;
  blocks: ToolUseBlock[];
}

/**
 * Saves a turn's pause checkpoint the first time one of its calls stops at
 * the approval gate, and rewrites it as sibling calls finish, so a restart
 * never runs a finished call again. Saves are chained so they land in order.
 * A failed save is logged and leaves the turn without durability, never
 * failing the run.
 */
export class PauseRecorder {
  private readonly finished = new Map<string, ToolResultBlock>();
  private saved_at: Date | undefined;
  private ok = false;
  private chain: Promise<void> = Promise.resolve();

  /**
   * @param store - Where the checkpoint goes.
   * @param turn - The turn being watched.
   * @param durable - Whether the stores outlive the process.
   */
  constructor(
    private readonly store: CheckpointStore,
    private readonly turn: PauseTurn,
    private readonly durable: boolean,
  ) {
    for (const block of turn.blocks) recorders.set(block, this);
  }

  /** Save the checkpoint, once the first call reaches the gate. Resolves after the save. */
  pause(): Promise<void> {
    this.saved_at ??= new Date();
    return this.save();
  }

  /** Note a finished call; rewrites the checkpoint once the turn has paused. */
  finish(result: ToolResultBlock): void {
    this.finished.set(result.tool_use_id, result);
    if (this.saved_at !== undefined) void this.save();
  }

  /** Resolves once every save started so far has landed. */
  settled(): Promise<void> {
    return this.chain;
  }

  /** Whether an aborted wait may leave its approval pending for another process. */
  keepsPending(): boolean {
    return this.durable && this.ok;
  }

  private save(): Promise<void> {
    const saved_at = this.saved_at ?? new Date();
    const blocks = this.turn.blocks;
    const cp = buildPauseCheckpoint({
      session_id: this.turn.session_id,
      turn: this.turn.turn,
      messages: this.turn.messages,
      finished: blocks.flatMap((b) => this.finished.get(b.id) ?? []),
      pending: blocks.filter((b) => !this.finished.has(b.id)).map((b) => b.id),
      usage: this.turn.usage,
      saved_at,
    });
    this.chain = this.chain.then(() => this.store.save(cp)).then(
      () => { this.ok = true; },
      (err: unknown) => {
        this.ok = false;
        logger.error(
          { session: cp.session_id, turn: cp.turn, error: err instanceof Error ? err.message : String(err) },
          "Pause checkpoint save failed; this approval will not survive a restart",
        );
      },
    );
    return this.chain;
  }
}

/**
 * The recorder watching a call's turn, if any.
 *
 * @param block - The call.
 * @returns Its turn's recorder.
 */
export function recorderFor(block: ToolUseBlock): PauseRecorder | undefined {
  return recorders.get(block);
}

/**
 * Mark a paused turn's calls with their decisions and return the response
 * to replay in place of a model call.
 *
 * @param turn - The planned turn.
 * @returns The assistant response that asked for the calls.
 */
export function replayResponse(turn: PausedTurn): PausedTurn["response"] {
  for (const block of turn.response.content) {
    const decision = block.type === "tool_use" ? turn.dispositions.get(block.id) : undefined;
    if (block.type === "tool_use" && decision) decisions.set(block, decision);
  }
  return turn.response;
}

/**
 * The result a replayed call returns without running: its result from
 * before the restart, or an error when it was cut off by the restart.
 *
 * @param block - The call.
 * @returns The result, or `undefined` when the call should go on as normal.
 */
export function presetResult(block: ToolUseBlock): ToolResultBlock | undefined {
  const decision = decisions.get(block);
  if (decision?.kind === "done") return decision.result;
  if (decision?.kind !== "interrupted") return undefined;
  return {
    type: "tool_result",
    tool_use_id: block.id,
    content: `Tool "${block.name}" was interrupted by restart and was not run again. Call it again if it is still needed.`,
    is_error: true,
  };
}

/**
 * The stored decision for a replayed call at the approval gate.
 *
 * @param block - The call.
 * @returns `true` when approved before the restart, `false` when no stored decision applies.
 * @throws {InterruptDeniedError} When it was denied, exactly as a live denial.
 */
export function approvedBeforeRestart(block: ToolUseBlock): boolean {
  const decision = decisions.get(block);
  if (decision?.kind === "denied") {
    const r = decision.record;
    throw new InterruptDeniedError(r.tool_name, r.denial_reason ?? "denied", r.interrupt_id);
  }
  return decision?.kind === "approved";
}
