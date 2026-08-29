/**
 * Pure helper functions used by the agent run pipeline.
 *
 * Every function here is side-effect free and depends only on its arguments,
 * which is why they live outside {@link AgentRunner} — they are the parts of
 * the run that can be understood and tested in isolation.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ContentBlock, Tool, ToolDefinition } from "@tuttiai/types";
import type { UserProfile } from "../memory/user-model.js";

/**
 * Convert a {@link Tool} into the provider-facing {@link ToolDefinition},
 * rendering its Zod parameter schema as OpenAPI-3-flavoured JSON Schema.
 *
 * @param tool - The tool to describe.
 * @returns The definition sent to the LLM in a chat request.
 */
export function toolToDefinition(tool: Tool): ToolDefinition {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- Zod generic variance: Tool<unknown> vs zodToJsonSchema's expected ZodType<any>
  const jsonSchema = zodToJsonSchema(tool.parameters, { target: "openApi3" });
  return {
    name: tool.name,
    description: tool.description,
    input_schema: jsonSchema,
  };
}

/**
 * Flatten a message content payload down to its text.
 *
 * @param content - A raw string, a block list, or nothing.
 * @returns The concatenated text of every text block, or `""`.
 */
export function extractText(content: string | ContentBlock[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");
}

/**
 * Format a {@link UserProfile} for inclusion in the agent's system
 * prompt. Returns an empty string when the profile is bootstrap-empty
 * (no summary, no preferences, no projects) so the runtime doesn't
 * inject dead weight on a brand-new user.
 *
 * @param profile - The consolidated user profile.
 * @returns A prompt fragment, or `""` when there is nothing to say.
 */
export function renderProfileForPrompt(profile: UserProfile): string {
  const hasSummary = profile.summary.trim().length > 0;
  const prefEntries = Object.entries(profile.preferences);
  const hasProjects = profile.ongoing_projects.length > 0;
  if (!hasSummary && prefEntries.length === 0 && !hasProjects) return "";

  const parts: string[] = ["\n\nUser profile:"];
  if (hasSummary) parts.push(profile.summary.trim());

  if (prefEntries.length > 0) {
    parts.push("Known preferences:");
    for (const [key, value] of prefEntries) {
      parts.push("- " + key + ": " + value);
    }
  }

  if (hasProjects) {
    parts.push("Ongoing projects:");
    for (const proj of profile.ongoing_projects) {
      parts.push("- " + proj);
    }
  }

  return parts.join("\n");
}

/**
 * Render a UserMemoryImportance literal as a human-readable label.
 *
 * @param importance - The numeric importance level.
 * @returns `"high"`, `"low"`, or `"normal"`.
 */
export function importanceLabel(importance: 1 | 2 | 3): string {
  if (importance === 3) return "high";
  if (importance === 1) return "low";
  return "normal";
}

/**
 * Parse the LLM's auto-infer response. Tolerates code-fenced JSON, prose
 * around the array, and accidentally-doubled wrappers — the LLM does not
 * always cooperate. Returns an empty array on any parse error rather
 * than throwing; auto-infer is best-effort.
 *
 * @param text - The raw model response.
 * @returns The inferred memory strings, or `[]` when nothing parses.
 */
export function parseInferredMemories(text: string): string[] {
  if (text === "") return [];
  // Strip a single leading/trailing code fence if present.
  let body = text.trim();
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(body);
  if (match) body = match[1].trim();

  // Find the first '[' and the matching last ']' — robust to leading prose.
  const first = body.indexOf("[");
  const last = body.lastIndexOf("]");
  if (first === -1 || last === -1 || last < first) return [];
  const sliced = body.slice(first, last + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(sliced);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((x): x is string => typeof x === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
