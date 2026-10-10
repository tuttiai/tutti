/**
 * The agent-shaping variables `start.ts` reads beyond a prompt and a model.
 *
 * | Variable | Shape | Absent means |
 * |---|---|---|
 * | `TUTTI_VOICES` | JSON array of `{ voice, options, only? }` | no voices |
 * | `TUTTI_PERMISSIONS` | comma-separated `network,filesystem,shell,browser` | none granted |
 * | `TUTTI_MAX_TURNS` | positive integer | the runtime default |
 * | `TUTTI_MAX_TOOL_CALLS` | positive integer | the runtime default |
 * | `TUTTI_MAX_COST_USD` | positive decimal | no ceiling |
 * | `TUTTI_TOOL_TIMEOUT_MS` | positive integer | the runtime default, 30 seconds |
 * | `TUTTI_MAX_TOOL_RESULT_CHARS` | positive integer | tool results enter the conversation whole |
 * | `TUTTI_TRIM_AFTER_TOKENS` | positive integer | older tool results are never shortened |
 * | `TUTTI_SUMMARISE_AFTER_TOKENS` | positive integer | older conversation is never summarised |
 * | `TUTTI_REQUIRE_APPROVAL` | see below | gate tools marked `destructive` |
 *
 * `TUTTI_REQUIRE_APPROVAL` sets the agent's `requireApproval`:
 *
 * | Value | `requireApproval` | Gated |
 * |---|---|---|
 * | absent, empty or `destructive` | `undefined` | tools marked `destructive: true` |
 * | `none` | `false` | nothing, destructive tools included |
 * | `all` | `"all"` | every tool call |
 * | `send_*, create_pull_request` | `string[]` | matching names, plus destructive tools |
 *
 * A list is comma-separated, trimmed, with empty items dropped. Each item is
 * a tool name or glob of `[A-Za-z0-9_*.-]+`, and anything else is refused.
 * `*` is the framework matcher's only wildcard. `?` is refused rather than
 * accepted as a literal, because no tool name holds one and a person writing
 * it expects a wildcard the matcher does not have.
 *
 * The last three set the agent's `context` (see `AgentContextConfig`), which
 * decides how much of a long conversation is re-sent to the model each turn.
 *
 * `TUTTI_VOICES` carries credentials inside `options`, so nothing here ever
 * echoes its content: a JSON syntax error is reported without the snippet
 * Node would quote, and a shape error by path and code only.
 */

import { z } from "zod";
import type { AgentConfig, AgentContextConfig, Permission } from "@tuttiai/types";

import { VoiceConfigError, VoiceSpecsSchema, type VoiceSpec } from "./voice-loader.js";

/** Reads one variable. `SecretsManager.optional` in production, a map in tests. */
export type ReadVariable = (key: string) => string | undefined;

/** What the variables add to the one agent the image runs. */
export interface StartAgentEnv {
  readonly voices: readonly VoiceSpec[];
  readonly permissions: readonly Permission[];
  readonly max_turns: number | undefined;
  readonly max_tool_calls: number | undefined;
  readonly max_cost_usd: number | undefined;
  /** How long one tool call may run, in milliseconds. A sandbox that builds a repository needs minutes. */
  readonly tool_timeout_ms: number | undefined;
  /** The agent's `context`, or `undefined` when none of its variables is set. */
  readonly context: AgentContextConfig | undefined;
  /** The agent's `requireApproval`. `undefined` gates destructive tools only. */
  readonly require_approval: AgentConfig["requireApproval"];
}

const PermissionSchema = z.enum(["network", "filesystem", "shell", "browser"]);
const PositiveInt = z.coerce.number().int().positive();
const PositiveAmount = z.coerce.number().positive().finite();

/** Parse `TUTTI_VOICES` without ever quoting what it holds. */
function readVoices(raw: string | undefined): VoiceSpec[] {
  if (raw === undefined || raw.trim() === "") return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new VoiceConfigError("TUTTI_VOICES is not valid JSON.");
  }
  const parsed = VoiceSpecsSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} (${i.code})`);
    throw new VoiceConfigError(`TUTTI_VOICES has the wrong shape: ${where.join(", ")}.`);
  }
  return parsed.data;
}

/** Parse `TUTTI_PERMISSIONS`, refusing a permission the framework does not have. */
function readPermissions(raw: string | undefined): Permission[] {
  if (raw === undefined || raw.trim() === "") return [];
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  return names.map((name) => {
    const parsed = PermissionSchema.safeParse(name);
    if (!parsed.success) {
      throw new VoiceConfigError(
        `TUTTI_PERMISSIONS names "${name}", which is not one of: ${PermissionSchema.options.join(", ")}.`,
      );
    }
    return parsed.data;
  });
}

const APPROVAL_PATTERN = /^[A-Za-z0-9_*.-]+$/;

/** Parse `TUTTI_REQUIRE_APPROVAL`, refusing an item that is not a tool name or glob. */
function readRequireApproval(raw: string | undefined): AgentConfig["requireApproval"] {
  const value = raw?.trim() ?? "";
  if (value === "" || value === "destructive") return undefined;
  if (value === "none") return false;
  if (value === "all") return "all";
  const patterns = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  for (const pattern of patterns) {
    if (!APPROVAL_PATTERN.test(pattern)) {
      throw new VoiceConfigError(
        `TUTTI_REQUIRE_APPROVAL names "${pattern}", which is not a tool name or glob ` +
          "(letters, digits and _ * . - only). Use destructive, none, all or a comma-separated list.",
      );
    }
  }
  // Only commas, so nothing survived: the same as leaving it unset.
  return patterns.length === 0 ? undefined : patterns;
}

/** Parse one optional numeric variable. */
function readNumber(read: ReadVariable, key: string, schema: z.ZodNumber): number | undefined {
  const raw = read(key);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new VoiceConfigError(`${key} must be a positive number.`);
  return parsed.data;
}

/** Read the context variables. Only those set are carried, so the framework's defaults fill the rest. */
function readContext(read: ReadVariable): AgentContextConfig | undefined {
  const context: AgentContextConfig = {};
  const maxResult = readNumber(read, "TUTTI_MAX_TOOL_RESULT_CHARS", PositiveInt);
  const trimAfter = readNumber(read, "TUTTI_TRIM_AFTER_TOKENS", PositiveInt);
  const summariseAfter = readNumber(read, "TUTTI_SUMMARISE_AFTER_TOKENS", PositiveInt);
  if (maxResult !== undefined) context.max_tool_result_chars = maxResult;
  if (trimAfter !== undefined) context.trim_after_tokens = trimAfter;
  if (summariseAfter !== undefined) context.summarise_after_tokens = summariseAfter;
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * Read the agent-shaping variables.
 *
 * @param read - Reads one variable.
 * @returns What they add to the agent.
 * @throws {VoiceConfigError} When any of them is malformed.
 *
 * @example
 * const env = readStartAgentEnv((key) => SecretsManager.optional(key));
 */
export function readStartAgentEnv(read: ReadVariable): StartAgentEnv {
  return {
    voices: readVoices(read("TUTTI_VOICES")),
    permissions: readPermissions(read("TUTTI_PERMISSIONS")),
    max_turns: readNumber(read, "TUTTI_MAX_TURNS", PositiveInt),
    max_tool_calls: readNumber(read, "TUTTI_MAX_TOOL_CALLS", PositiveInt),
    max_cost_usd: readNumber(read, "TUTTI_MAX_COST_USD", PositiveAmount),
    tool_timeout_ms: readNumber(read, "TUTTI_TOOL_TIMEOUT_MS", PositiveInt),
    context: readContext(read),
    require_approval: readRequireApproval(read("TUTTI_REQUIRE_APPROVAL")),
  };
}
