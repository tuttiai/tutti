/**
 * Dialectic user model — an evolving, LLM-summarised profile of an
 * end-user, distilled periodically from accumulated user-memory entries.
 *
 * Distinct from {@link UserMemoryStore} (granular per-fact memory). The
 * fact store keeps individual statements ("user prefers TypeScript");
 * the user model keeps a single rolling profile ("who is this person —
 * tone, projects, preferences"). Both surfaces inject into the system
 * prompt; the model gives the agent a holistic picture, the facts give
 * it audit-traceable specifics.
 *
 * @module
 */

import { z } from "zod";

/**
 * Maximum length (in characters) accepted on `summary`. Past this we
 * truncate the LLM-written summary defensively before storing — keeps a
 * runaway model from inflating the profile to megabytes.
 */
export const MAX_SUMMARY_CHARS = 4000;

/**
 * One persisted user profile — a single document per `user_id`.
 *
 * `last_consolidated_turn` tracks the cumulative `turn_count` value at
 * the time of the last consolidation; the consolidator triggers when
 * `turn_count - last_consolidated_turn >= every_n_turns`. Both fields
 * are turn counters, NOT wall-clock timestamps.
 */
export interface UserProfile {
  /** End-user identity. Opaque to the runtime — applications choose the namespace. */
  user_id: string;
  /**
   * Free-text LLM-written profile. Capped at {@link MAX_SUMMARY_CHARS}
   * on store. Empty string on a freshly-bootstrapped profile.
   */
  summary: string;
  /**
   * Structured key/value preferences inferred over time. Keys are
   * normalised to snake_case by the consolidator (e.g.
   * `"communication_style": "terse, no emojis"`).
   */
  preferences: Record<string, string>;
  /** Short labels for projects the user is actively engaged with. */
  ongoing_projects: string[];
  /**
   * Cumulative turn counter across every run for this user. Bumped by
   * the consolidator on every `maybeConsolidate` call.
   */
  turn_count: number;
  /**
   * Value of `turn_count` at the time of the most-recent successful
   * consolidation. The trigger comparison is
   * `turn_count - last_consolidated_turn >= every_n_turns`. Zero on a
   * brand-new profile.
   */
  last_consolidated_turn: number;
}

/**
 * Zod schema validating the shape an LLM consolidation pass returns.
 * Used by {@link UserModelConsolidator} to guard against malformed
 * model output before persisting.
 */
export const UserProfileWritableSchema = z.object({
  summary: z.string().max(MAX_SUMMARY_CHARS),
  preferences: z.record(z.string(), z.string()),
  ongoing_projects: z.array(z.string()),
});

/** Subset of {@link UserProfile} the LLM consolidation pass produces. */
export type UserProfileWritable = z.infer<typeof UserProfileWritableSchema>;

/**
 * Pluggable backend for {@link UserProfile} persistence. Implementations
 * include {@link InMemoryUserModelStore} (ephemeral, dev / tests). A
 * Postgres-backed implementation can land later behind the same
 * interface without runtime changes.
 *
 * Methods:
 *
 * - `get` — direct lookup; returns `null` (not throws) when missing so
 *   callers can distinguish absence from error.
 * - `upsert` — write-the-whole-record. Idempotent on `user_id`.
 * - `delete` — hard-delete. No-op on unknown ids so callers can use
 *   this as a cleanup primitive (matches `UserMemoryStore.deleteAll`).
 */
export interface UserModelStore {
  get(user_id: string): Promise<UserProfile | null>;
  upsert(profile: UserProfile): Promise<void>;
  delete(user_id: string): Promise<void>;
}

/**
 * In-memory {@link UserModelStore} backed by a `Map<user_id, UserProfile>`.
 *
 * Suitable for tests, local dev, and ephemeral demos. **Do not use in
 * production** — profiles are lost on process restart and stored in
 * plaintext (no encryption at rest, no access control beyond the
 * `user_id` keying).
 */
export class InMemoryUserModelStore implements UserModelStore {
  private readonly byUser = new Map<string, UserProfile>();

  get(user_id: string): Promise<UserProfile | null> {
    const found = this.byUser.get(user_id);
    if (!found) return Promise.resolve(null);
    // Hand back a defensive shallow clone so caller mutations don't
    // race with concurrent reads.
    return Promise.resolve(cloneProfile(found));
  }

  upsert(profile: UserProfile): Promise<void> {
    this.byUser.set(profile.user_id, cloneProfile(profile));
    return Promise.resolve();
  }

  delete(user_id: string): Promise<void> {
    this.byUser.delete(user_id);
    return Promise.resolve();
  }
}

/**
 * Build a fresh {@link UserProfile} for a user that has none yet.
 * Centralised so the consolidator and any direct callers share defaults.
 */
export function emptyProfile(user_id: string): UserProfile {
  return {
    user_id,
    summary: "",
    preferences: {},
    ongoing_projects: [],
    turn_count: 0,
    last_consolidated_turn: 0,
  };
}

function cloneProfile(p: UserProfile): UserProfile {
  return {
    user_id: p.user_id,
    summary: p.summary,
    preferences: { ...p.preferences },
    ongoing_projects: [...p.ongoing_projects],
    turn_count: p.turn_count,
    last_consolidated_turn: p.last_consolidated_turn,
  };
}
