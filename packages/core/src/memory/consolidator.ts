/**
 * Periodic LLM-driven consolidator that distils a user's accumulated
 * {@link UserMemory} entries into a single rolling {@link UserProfile}.
 *
 * Triggers on a configurable cadence (default: every 20 turns) so the
 * profile lags reality by a bounded amount but does not pay the LLM
 * cost on every run. All work runs out-of-band of the agent's main turn
 * — failures are logged and swallowed; the agent run never sees them.
 *
 * @module
 */

import type { ChatResponse, ContentBlock, LLMProvider } from "@tuttiai/types";

import type { EventBus } from "../event-bus.js";
import { logger } from "../logger.js";
import {
  type UserModelStore,
  type UserProfile,
  type UserProfileWritable,
  UserProfileWritableSchema,
  emptyProfile,
} from "./user-model.js";
import type { UserMemory, UserMemoryStore } from "./user/types.js";

/** Default for {@link UserModelConsolidatorOptions.every_n_turns}. */
export const DEFAULT_EVERY_N_TURNS = 20;
/** How many recent memories the consolidator feeds the LLM each pass. */
export const DEFAULT_RECENT_MEMORY_LIMIT = 50;

/**
 * Wiring options for {@link UserModelConsolidator}. A single options
 * bag (rather than positional args) keeps the constructor at three
 * params and lets new knobs land without breaking the signature —
 * required by `CLAUDE.md` Section 5 (max-3-params rule).
 */
export interface UserModelConsolidatorOptions {
  /** Minimum turns since the last consolidation before re-running. */
  every_n_turns?: number;
  /** Optional LLM model override. Falls back to whatever the provider picks. */
  model?: string;
  /** Cap on how many recent memories get fed to the LLM each pass. */
  recent_memory_limit?: number;
  /** EventBus for `user_model:consolidated`. Optional — testable in isolation. */
  events?: EventBus;
}

/**
 * Coordinates the periodic consolidation pass. The class is stateless
 * with respect to per-user data — every state mutation goes through
 * {@link UserModelStore}, which keeps the consolidator safe to share
 * across agents and runs.
 *
 * `maybeConsolidate` is best-effort: it MUST NOT throw into a caller's
 * happy path. Errors are caught, logged, and swallowed.
 */
export class UserModelConsolidator {
  private readonly everyNTurns: number;
  private readonly recentMemoryLimit: number;
  private readonly model: string | undefined;
  private readonly events: EventBus | undefined;

  constructor(
    private readonly modelStore: UserModelStore,
    private readonly memory: UserMemoryStore,
    private readonly llm: LLMProvider,
    options: UserModelConsolidatorOptions = {},
  ) {
    this.everyNTurns = options.every_n_turns ?? DEFAULT_EVERY_N_TURNS;
    this.recentMemoryLimit =
      options.recent_memory_limit ?? DEFAULT_RECENT_MEMORY_LIMIT;
    this.model = options.model;
    this.events = options.events;
  }

  /**
   * Bump the user's cumulative turn counter by `runTurnCount` and, if
   * enough turns have accumulated since the last consolidation, run an
   * LLM pass to refresh the profile.
   *
   * Always non-throwing: provider errors, malformed JSON, or schema
   * violations are logged and swallowed. The previous profile is left
   * untouched on any failure path.
   *
   * @param userId End-user identity. Opaque — chosen by the application.
   * @param runTurnCount Turns from the run that just completed. Added to the user's cumulative counter.
   */
  async maybeConsolidate(userId: string, runTurnCount: number): Promise<void> {
    if (runTurnCount <= 0) return;

    let profile: UserProfile;
    try {
      const existing = await this.modelStore.get(userId);
      profile = existing ?? emptyProfile(userId);
      profile.turn_count += runTurnCount;
      // Persist the bump even if we don't consolidate — otherwise the
      // counter resets every time the process restarts under an
      // ephemeral store.
      await this.modelStore.upsert(profile);
    } catch (err) {
      logger.warn(
        { error: errMsg(err), user_id: userId },
        "User-model turn-count bump failed — skipping consolidation",
      );
      return;
    }

    const turnsSince = profile.turn_count - profile.last_consolidated_turn;
    if (turnsSince < this.everyNTurns) return;

    try {
      const next = await this.runPass(userId, profile);
      if (next) {
        await this.modelStore.upsert(next);
        this.events?.emit({
          type: "user_model:consolidated",
          user_id: userId,
          turn_count: next.turn_count,
        });
      }
    } catch (err) {
      // Catch-all — ensures fire-and-forget callers never see a throw.
      logger.warn(
        { error: errMsg(err), user_id: userId },
        "User-model consolidation failed — keeping previous profile",
      );
    }
  }

  /**
   * Run a single LLM consolidation pass. Returns the next profile to
   * persist, or `null` when the pass produced nothing usable (parse
   * failure, schema violation, empty output) — in which case the caller
   * keeps the previous profile.
   */
  private async runPass(
    userId: string,
    profile: UserProfile,
  ): Promise<UserProfile | null> {
    const recent = await this.memory.list(userId);
    const window = recent.slice(0, this.recentMemoryLimit);
    if (window.length === 0 && profile.summary === "") {
      // Nothing to summarise — skip the LLM call entirely so brand-new
      // users don't burn tokens on an empty profile.
      return null;
    }

    const system = buildSystemPrompt();
    const userMessage = buildUserMessage(profile, window);

    let response: ChatResponse;
    try {
      response = await this.llm.chat({
        ...(this.model !== undefined ? { model: this.model } : {}),
        system,
        messages: [{ role: "user", content: userMessage }],
      });
    } catch (err) {
      logger.warn(
        { error: errMsg(err), user_id: userId },
        "User-model consolidation LLM call failed",
      );
      return null;
    }

    const text = extractText(response.content).trim();
    const writable = parseProfileWritable(text);
    if (!writable) {
      logger.warn(
        { user_id: userId, sample: text.slice(0, 120) },
        "User-model consolidation produced unparseable JSON — keeping previous profile",
      );
      return null;
    }

    return {
      user_id: userId,
      summary: writable.summary,
      preferences: writable.preferences,
      ongoing_projects: writable.ongoing_projects,
      turn_count: profile.turn_count,
      last_consolidated_turn: profile.turn_count,
    };
  }
}

function buildSystemPrompt(): string {
  return (
    "You maintain a profile of an end-user, distilled from their recent " +
    "interactions with an AI assistant. You will receive: (a) the current " +
    "profile, if any, and (b) a list of recent memory entries about the user.\n\n" +
    "Output a single JSON object — and nothing else, no prose, no code fences — " +
    "with these fields:\n" +
    "  summary: string under 500 words describing who the user is, what they care about, " +
    "and how they communicate.\n" +
    "  preferences: object mapping snake_case keys to short string values " +
    "(e.g. \"communication_style\": \"terse, no emojis\").\n" +
    "  ongoing_projects: array of short labels for projects the user is actively engaged with.\n\n" +
    "Be conservative: only include facts you have direct evidence for in the inputs. " +
    "Prefer dropping a fact over guessing one. " +
    "Some recent memories may already be reflected in the existing summary — " +
    "incorporate only what's new or contradicted.\n\n" +
    "NEVER include sensitive data: no passwords, API keys, secrets, social-security " +
    "or national-id numbers, payment-card numbers, or government identifiers. " +
    "If a memory contains such data, omit it entirely from your output."
  );
}

function buildUserMessage(profile: UserProfile, recent: UserMemory[]): string {
  const profileBlock =
    profile.summary === "" && Object.keys(profile.preferences).length === 0
      ? "(none — bootstrap a fresh profile)"
      : JSON.stringify(
          {
            summary: profile.summary,
            preferences: profile.preferences,
            ongoing_projects: profile.ongoing_projects,
          },
          null,
          2,
        );

  const memoryBlock =
    recent.length === 0
      ? "(none)"
      : recent
          .map(
            (m) =>
              "- [" +
              m.source +
              ", importance=" +
              String(m.importance) +
              "] " +
              m.content,
          )
          .join("\n");

  return (
    "Current profile:\n" +
    profileBlock +
    "\n\nRecent memory entries:\n" +
    memoryBlock
  );
}

/**
 * Parse the LLM consolidation response. Tolerates code-fenced JSON and
 * prose around the object — the LLM does not always cooperate.
 * Validates against {@link UserProfileWritableSchema} before returning;
 * any deviation yields `null` so the caller keeps the previous profile.
 */
function parseProfileWritable(text: string): UserProfileWritable | null {
  if (text === "") return null;
  let body = text.trim();
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(body);
  if (match && match[1]) body = match[1].trim();

  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  const sliced = body.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return null;
  }
  const result = UserProfileWritableSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}
