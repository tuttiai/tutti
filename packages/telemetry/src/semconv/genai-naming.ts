import type { AttributeValue, Attributes } from "@opentelemetry/api";

import type { SpanKind, TuttiSpan, TuttiSpanAttributes } from "../types.js";
import {
  ERROR_TYPE_OTHER,
  GEN_AI_ATTRIBUTES as GEN_AI,
  GEN_AI_OPERATIONS as OPS,
} from "./genai-attributes.js";
import { legacySpanNaming, tuttiAttrsToOTel, type SpanNamingStrategy } from "./naming.js";

/** How one span kind maps to a GenAI operation. */
interface GenAiKindRule {
  /** Value of `gen_ai.operation.name` and first word of the span name. */
  readonly operation: string;
  /** Attribute whose value completes the span name (`chat {model}`). */
  readonly nameFrom: keyof TuttiSpanAttributes;
  /** Legacy keys replaced by a GenAI key carrying the same value. */
  readonly renames: ReadonlyMap<string, string>;
  /** Legacy keys copied to a GenAI key, the legacy key kept as well. */
  readonly copies: ReadonlyMap<string, string>;
  /** Legacy keys left out because they carry content. */
  readonly drops: ReadonlySet<string>;
}

const RULES: Partial<Record<SpanKind, GenAiKindRule>> = {
  agent: {
    operation: OPS.INVOKE_AGENT,
    nameFrom: "agent_id",
    renames: new Map([
      ["agent_id", GEN_AI.AGENT_NAME],
      ["model", GEN_AI.REQUEST_MODEL],
    ]),
    copies: new Map([["session_id", GEN_AI.CONVERSATION_ID]]),
    drops: new Set(),
  },
  llm: {
    operation: OPS.CHAT,
    nameFrom: "model",
    renames: new Map([
      ["model", GEN_AI.REQUEST_MODEL],
      ["prompt_tokens", GEN_AI.USAGE_INPUT_TOKENS],
      ["completion_tokens", GEN_AI.USAGE_OUTPUT_TOKENS],
      ["cache_read_tokens", GEN_AI.USAGE_CACHE_READ_INPUT_TOKENS],
      ["cache_creation_tokens", GEN_AI.USAGE_CACHE_CREATION_INPUT_TOKENS],
    ]),
    copies: new Map(),
    drops: new Set(),
  },
  tool: {
    operation: OPS.EXECUTE_TOOL,
    nameFrom: "tool_name",
    renames: new Map([["tool_name", GEN_AI.TOOL_NAME]]),
    copies: new Map(),
    drops: new Set(["tool_input", "tool_output"]),
  },
};

/** A name-like value worth emitting: a string that is not blank. */
function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Names must be non-blank strings and token counts non-negative integers. */
function isEmittable(value: AttributeValue | undefined): value is AttributeValue {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
  return nonBlank(value) !== undefined;
}

/** Build the GenAI attribute set from the legacy one, in a stable order. */
function toGenAiAttributes(legacy: Attributes, rule: GenAiKindRule, span: TuttiSpan): Attributes {
  const entries: Array<[string, AttributeValue | undefined]> = [
    [GEN_AI.OPERATION_NAME, rule.operation],
  ];
  for (const [key, value] of Object.entries(legacy)) {
    if (rule.drops.has(key)) continue;
    const renamed = rule.renames.get(key);
    if (renamed !== undefined) {
      if (isEmittable(value)) entries.push([renamed, value]);
      continue;
    }
    const copied = rule.copies.get(key);
    if (copied !== undefined && isEmittable(value)) entries.push([copied, value]);
    entries.push([key, value]);
  }
  if (span.status === "error") entries.push([GEN_AI.ERROR_TYPE, ERROR_TYPE_OTHER]);
  return Object.fromEntries(entries);
}

/**
 * GenAI strategy: agent, LLM and tool spans are exported with the
 * OpenTelemetry GenAI semantic-convention names (`invoke_agent {agent}`,
 * `chat {model}`, `execute_tool {tool}`) and `gen_ai.*` attributes
 * (checked against semantic conventions 1.43.0, GenAI in Development
 * status). Legacy keys with a GenAI equivalent are replaced, tool input and
 * output are left out, and every other attribute, including `tutti.kind`,
 * is kept. A blank or missing name gives the bare operation as the span
 * name. A failed span gets `error.type` `_OTHER`. Guardrail and checkpoint
 * spans are exported exactly as {@link legacySpanNaming} exports them.
 * No prompt, completion or tool content is ever added.
 */
export const genAiSpanNaming: SpanNamingStrategy = (span) => {
  const rule = RULES[span.kind];
  if (rule === undefined) return legacySpanNaming(span);
  const target = nonBlank(span.attributes[rule.nameFrom]);
  return {
    name: target === undefined ? rule.operation : `${rule.operation} ${target}`,
    attributes: toGenAiAttributes(tuttiAttrsToOTel(span.attributes, span), rule, span),
  };
};
