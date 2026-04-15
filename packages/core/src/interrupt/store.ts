import type {
  InterruptCreateInput,
  InterruptRequest,
  ResolveOptions,
} from "./types.js";

/**
 * Pluggable backend for {@link InterruptRequest} records.
 *
 * Implementations include {@link MemoryInterruptStore} (ephemeral, dev
 * / tests) and {@link PostgresInterruptStore} (persistent, production).
 *
 * Method semantics:
 *
 * - `create` — persists a new request and returns the record with
 *   `interrupt_id`, `requested_at`, and `status: "pending"` filled in.
 * - `get` — direct lookup by id; returns `null` (not throws) when the
 *   id is unknown so callers can distinguish absence from error.
 * - `resolve` — transitions a request to `"approved"` or `"denied"`,
 *   stamps `resolved_at`, and records the optional metadata. Throws
 *   when the id is unknown; calling `resolve` on an already-resolved
 *   id is idempotent — returns the existing record unchanged so a
 *   duplicate operator click doesn't error.
 * - `listPending` — every request currently in the `"pending"` state,
 *   ordered oldest-first. Optionally filtered by `session_id` for UIs
 *   that show a per-run review queue.
 * - `listBySession` — every request for one session regardless of
 *   status, oldest-first. Used by per-session review views that need
 *   to show approved / denied history alongside pending items.
 */
export interface InterruptStore {
  create(input: InterruptCreateInput): Promise<InterruptRequest>;
  get(interrupt_id: string): Promise<InterruptRequest | null>;
  resolve(
    interrupt_id: string,
    status: "approved" | "denied",
    options?: ResolveOptions,
  ): Promise<InterruptRequest>;
  listPending(session_id?: string): Promise<InterruptRequest[]>;
  listBySession(session_id: string): Promise<InterruptRequest[]>;
}
