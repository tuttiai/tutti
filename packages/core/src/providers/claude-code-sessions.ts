import { createHash } from "node:crypto";

import type { ChatMessage, ChatRequest, ContentBlock } from "@tuttiai/types";

/*
 * Why sessions are resumed. Claude Code's prompt cache only ever paid off for
 * a request identical to an earlier one: a stateless call that re-sends a
 * longer transcript was written to the cache in full on every turn and read
 * nothing back, so a ten-turn reply paid for its opening context ten times
 * over. Resuming the session that already holds the conversation, and sending
 * only the messages added since, reads that context from the cache instead.
 *
 * Nothing about the conversation is trusted to stay the same: an entry is
 * found by a hash of everything the session was given (model, system prompt,
 * tools and every message, including the reply it produced), so a hook that
 * rewrites history, a trimmed tool result or a changed tool list simply finds
 * no entry and the call starts a fresh session with the whole transcript.
 */

/** A conversation a Claude Code session already holds, and what is new since. */
export interface SessionResume {
  /** The Claude Code session to resume. */
  session_id: string;
  /** The messages after the session's last reply, oldest first. Every one is a user message. */
  delta: ChatMessage[];
}

interface Entry {
  session_id: string;
  stored_at: number;
}

/** Options for {@link ClaudeCodeSessions}. */
export interface ClaudeCodeSessionsOptions {
  /** Most conversations remembered at once; the oldest is forgotten first. Default 256. */
  max_entries?: number;
  /** Forget a conversation idle this long. Default one hour, the life of Claude Code's cache. */
  ttl_ms?: number;
  /** Clock, for tests. */
  now?: () => number;
}

/**
 * Remembers which Claude Code session holds which conversation, so the next
 * turn of that conversation can resume it.
 */
export class ClaudeCodeSessions {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: ClaudeCodeSessionsOptions = {}) {
    this.maxEntries = options.max_entries ?? 256;
    this.ttlMs = options.ttl_ms ?? 3_600_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Claim the session holding everything in `request` up to its new user
   * messages. The entry is removed, so two concurrent calls never resume one
   * session; the one that loses starts fresh.
   *
   * @param request - The chat request being served.
   * @returns The session and the new messages, or `undefined` to start fresh.
   */
  take(request: ChatRequest): SessionResume | undefined {
    const split = lastAssistantIndex(request.messages) + 1;
    if (split === 0 || split === request.messages.length) return undefined;
    const key = keyOf(request, request.messages.slice(0, split));
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (this.now() - entry.stored_at > this.ttlMs) return undefined;
    return { session_id: entry.session_id, delta: request.messages.slice(split) };
  }

  /**
   * Record that `session_id` now holds `request`'s conversation followed by
   * the reply it produced.
   *
   * @param request - The chat request that was served.
   * @param reply - The content of the reply, as the runner will append it.
   * @param session_id - The Claude Code session that produced it.
   */
  keep(request: ChatRequest, reply: ContentBlock[], session_id: string): void {
    const key = keyOf(request, [...request.messages, { role: "assistant", content: reply }]);
    this.entries.set(key, { session_id, stored_at: this.now() });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
  }
}

function lastAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages.at(i)?.role === "assistant") return i;
  }
  return -1;
}

function keyOf(request: ChatRequest, messages: ChatMessage[]): string {
  return createHash("sha256")
    .update(JSON.stringify([request.model ?? "", request.system ?? "", request.tools ?? [], messages]))
    .digest("hex");
}
