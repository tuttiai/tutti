/**
 * `SkillExecutor` — the "agent now has this new capability" half of the
 * self-improving skills pipeline.
 *
 * Pairs with {@link TrajectoryObserver} (record runs) and
 * {@link SkillProposer} (propose new skills). The executor takes
 * **approved** {@link Skill}s out of the {@link SkillStore} and projects
 * each one onto a callable {@link Tool} the runtime can hand to the LLM
 * alongside the agent's voice tools. Rejected and pending candidates are
 * ignored.
 *
 * Per-skill execution model:
 *   - `name` = `skill.name_suggestion`. When that name collides with a
 *     tool the agent already has from its voices, the runtime prefixes
 *     the colliding skill with `skill__` so both names stay callable.
 *   - `description` = `skill.description`. Surfaced to the LLM verbatim.
 *   - `parameters` = `skill.signature.input` (Zod schema preserved across
 *     approval; no re-derivation from JSON Schema).
 *   - `destructive` = `skill.is_destructive`. Computed at approval time
 *     as the union over constituent tools' `destructive` flags. The
 *     runtime's HITL gate uses this exactly like a voice tool.
 *   - `execute()` runs an inner LLM sub-agent loop with the skill's
 *     `system_prompt` (or its description as fallback) and the skill's
 *     constituent tools — resolved against the parent agent's voice
 *     tools at run start. Tool results from constituents flow back into
 *     the inner loop the same way the outer agent loop handles them.
 *
 * Permissions are validated **at run start**, not at skill invocation,
 * so an under-permissioned agent fails fast instead of partway through
 * a turn. The runtime passes the agent's granted permissions into
 * {@link SkillExecutor.toolsForAgent}; any approved skill whose
 * `required_permissions` are not a subset throws {@link PermissionError}.
 *
 * @module
 */

import type {
  ChatMessage,
  ChatResponse,
  ContentBlock,
  LLMProvider,
  Permission,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
  ToolResultBlock,
  ToolUseBlock,
} from "@tuttiai/types";
import type { Skill, SkillStore } from "@tuttiai/skills";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { EventBus } from "../event-bus.js";
import { PermissionError } from "../errors.js";
import { logger } from "../logger.js";

/** Default inner-loop model — small, fast, cheap. Matches the proposer's default. */
export const DEFAULT_SKILL_EXECUTOR_MODEL = "claude-haiku-4-5";
/** Default cap on inner-loop turns. */
export const DEFAULT_SKILL_EXECUTOR_MAX_TURNS = 5;

/** Wiring options for {@link SkillExecutor}. */
export interface SkillExecutorOptions {
  /** Backing store — must be the same store the observer and proposer use. */
  store: SkillStore;
  /** LLM provider for the inner sub-agent loop. */
  llm: LLMProvider;
  /** Inner-loop model. Defaults to {@link DEFAULT_SKILL_EXECUTOR_MODEL}. */
  model?: string;
  /**
   * Cap on inner-loop turns. A skill that exhausts the cap returns an
   * `is_error: true` tool result so the outer loop can recover rather
   * than hang. Defaults to {@link DEFAULT_SKILL_EXECUTOR_MAX_TURNS}.
   */
  maxTurns?: number;
  /** Optional bus for `skill:invoked`. Omit in tests when not needed. */
  events?: EventBus;
}

/**
 * Per-agent run context the runtime passes to
 * {@link SkillExecutor.toolsForAgent} when it materialises tools at run
 * start. All fields are optional so the executor can be exercised
 * standalone in tests — production callers supply all four.
 */
export interface SkillToolsContext {
  /**
   * Tools the agent already has from its voices. Used as the resolution
   * pool for each skill's constituent tools, and to detect name
   * collisions that need a `skill__` prefix.
   */
  tools?: Tool[];
  /**
   * Permissions granted to the agent. When supplied, the executor
   * throws {@link PermissionError} at this call site (run start) if any
   * approved skill's `required_permissions` are not a subset.
   */
  grantedPermissions?: Permission[];
  /**
   * Per-agent-run identifier — same value the runtime threads into the
   * `TrajectoryObserver`. Surfaced verbatim on every `skill:invoked`
   * event so subscribers can correlate the skill call with the parent
   * run's trajectory.
   */
  runId?: string;
}

/**
 * Projects approved {@link Skill}s onto callable {@link Tool}s. One
 * executor per runtime; safe to call {@link toolsForAgent} concurrently
 * (no mutable state).
 */
export class SkillExecutor {
  private readonly store: SkillStore;
  private readonly llm: LLMProvider;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly events: EventBus | undefined;

  constructor(opts: SkillExecutorOptions) {
    this.store = opts.store;
    this.llm = opts.llm;
    this.model = opts.model ?? DEFAULT_SKILL_EXECUTOR_MODEL;
    this.maxTurns = opts.maxTurns ?? DEFAULT_SKILL_EXECUTOR_MAX_TURNS;
    this.events = opts.events;
  }

  /**
   * Materialise the agent's approved skills as callable tools. Returns
   * an empty array when no approved skills cover the agent. Always
   * filters out rejected entries.
   *
   * @throws {PermissionError} when an approved skill's
   *   `required_permissions` are not a subset of
   *   `ctx.grantedPermissions` (only enforced when granted permissions
   *   are supplied).
   */
  async toolsForAgent(
    agentName: string,
    ctx: SkillToolsContext = {},
  ): Promise<Tool[]> {
    const all = await this.store.listSkills(agentName);
    const approved = all.filter((s) => s.status === "approved");
    if (approved.length === 0) return [];

    if (ctx.grantedPermissions !== undefined) {
      this.assertPermissions(approved, ctx.grantedPermissions);
    }

    const voiceToolNames = new Set((ctx.tools ?? []).map((t) => t.name));
    const constituentPool = ctx.tools ?? [];
    const runId = ctx.runId ?? "";

    return approved.map((skill) =>
      this.skillToTool(skill, agentName, voiceToolNames, constituentPool, runId),
    );
  }

  /**
   * Iterate the approved skills, raising {@link PermissionError} on the
   * first one whose required permissions are not a subset of `granted`.
   * Fails fast — the rest of the skills are not checked once a breach
   * is found.
   */
  private assertPermissions(skills: Skill[], granted: Permission[]): void {
    const grantedSet = new Set<string>(granted);
    for (const skill of skills) {
      const missing = skill.required_permissions.filter((p) => !grantedSet.has(p));
      if (missing.length > 0) {
        throw new PermissionError(
          `skill:${skill.name_suggestion}`,
          skill.required_permissions,
          granted,
        );
      }
    }
  }

  /** Build the `Tool` shape for one approved skill. */
  private skillToTool(
    skill: Skill,
    agentName: string,
    voiceToolNames: Set<string>,
    constituentPool: readonly Tool[],
    runId: string,
  ): Tool {
    const name = voiceToolNames.has(skill.name_suggestion)
      ? `skill__${skill.name_suggestion}`
      : skill.name_suggestion;

    const systemPrompt =
      skill.system_prompt ?? `Execute this skill: ${skill.description}`;
    const constituents = constituentPool.filter((t) =>
      skill.constituent_tools.includes(t.name),
    );

    return {
      name,
      description: skill.description,
      parameters: skill.signature.input,
      destructive: skill.is_destructive,
      execute: async (input: unknown, context: ToolContext): Promise<ToolResult> => {
        this.events?.emit({
          type: "skill:invoked",
          agent_name: agentName,
          skill_id: skill.id,
          run_id: runId,
        });
        return this.runInnerLoop(skill, systemPrompt, constituents, input, context);
      },
    };
  }

  /**
   * Inner sub-agent loop. Bounded by {@link maxTurns}; on exhaustion
   * returns an `is_error` result rather than throwing, so the outer
   * agent loop sees the same `ToolResult` contract as any other tool.
   *
   * Constituent tool errors (Zod validation, `execute` throws) are
   * caught and surfaced as inner `tool_result` blocks with `is_error`
   * so the inner LLM can self-correct without crashing the run.
   */
  private async runInnerLoop(
    skill: Skill,
    systemPrompt: string,
    constituents: readonly Tool[],
    input: unknown,
    context: ToolContext,
  ): Promise<ToolResult> {
    const toolDefs: ToolDefinition[] = constituents.map(toolToDefinition);
    const messages: ChatMessage[] = [
      { role: "user", content: JSON.stringify(input) },
    ];

    for (let turn = 0; turn < this.maxTurns; turn++) {
      let response: ChatResponse;
      try {
        response = await this.llm.chat({
          model: this.model,
          system: systemPrompt,
          messages,
          ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          { error: message, skill: skill.id, agent: context.agent_name },
          "Skill inner-loop LLM call failed",
        );
        return {
          content: `Skill "${skill.name_suggestion}" failed: ${message}`,
          is_error: true,
        };
      }

      messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason !== "tool_use") {
        return { content: extractText(response.content) };
      }

      const toolUses = response.content.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: ToolResultBlock[] = await Promise.all(
        toolUses.map((block) =>
          this.executeConstituent(skill, block, constituents, context),
        ),
      );
      messages.push({ role: "user", content: toolResults });
    }

    return {
      content: `Skill "${skill.name_suggestion}" did not finish within ${this.maxTurns} inner turns`,
      is_error: true,
    };
  }

  /** Resolve and run one constituent tool; never throws. */
  private async executeConstituent(
    skill: Skill,
    block: ToolUseBlock,
    constituents: readonly Tool[],
    context: ToolContext,
  ): Promise<ToolResultBlock> {
    const tool = constituents.find((t) => t.name === block.name);
    if (!tool) {
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Skill "${skill.name_suggestion}" cannot call tool "${block.name}" — not in its approved constituents`,
        is_error: true,
      };
    }
    try {
      const parsed = tool.parameters.parse(block.input);
      const result = await tool.execute(parsed, context);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: result.content,
        ...(result.is_error !== undefined ? { is_error: result.is_error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        type: "tool_result",
        tool_use_id: block.id,
        content: `Skill constituent tool error: ${message}`,
        is_error: true,
      };
    }
  }
}

function toolToDefinition(tool: Tool): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance; same exception as agent-runner.toolToDefinition.
  const jsonSchema = zodToJsonSchema(tool.parameters, { target: "openApi3" });
  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema as Record<string, unknown>,
  };
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is ContentBlock & { type: "text" } => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}
