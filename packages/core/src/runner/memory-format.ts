import type { MemoryEntry } from "../memory/semantic.js";
import type { UserMemory } from "../memory/user/types.js";
import type { UserProfile } from "../memory/user-model.js";

/**
 * Format a {@link UserProfile} for inclusion in the agent's system
 * prompt. Returns an empty string when the profile is bootstrap-empty
 * (no summary, no preferences, no projects) so the runtime doesn't
 * inject dead weight on a brand-new user.
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

/** Render a UserMemoryImportance literal as a human-readable label. */
export function importanceLabel(importance: 1 | 2 | 3): string {
  if (importance === 3) return "high";
  if (importance === 1) return "low";
  return "normal";
}

/**
 * Render the injected user memories as a system-prompt block. Returns
 * an empty string when there is nothing to inject.
 */
export function formatUserMemories(memories: UserMemory[]): string {
  if (memories.length === 0) return "";
  return "\n\nWhat I remember about you:\n" +
    memories
      .map((m) => "- " + m.content + " [importance: " + importanceLabel(m.importance) + "]")
      .join("\n");
}

/**
 * Render semantic memories as a system-prompt block. When the curated
 * tools are also active, a hint follows that the model may call them
 * to extend or correct this context. Returns an empty string when
 * there is nothing to inject.
 */
export function formatSemanticMemories(memories: MemoryEntry[], curatedTools: boolean): string {
  if (memories.length === 0) return "";
  const memoryBlock = memories.map((m) => `- ${m.content}`).join("\n");
  let block = "\n\nRelevant context from previous sessions:\n" + memoryBlock;
  if (curatedTools) {
    block +=
      "\n\nUse the `remember` tool when the user shares something worth keeping. " +
      "Use `recall` to look things up. " +
      "Use `forget` to remove an entry the user retracts.";
  }
  return block;
}

/**
 * Parse the LLM's auto-infer response. Tolerates code-fenced JSON, prose
 * around the array, and accidentally-doubled wrappers; the LLM does not
 * always cooperate. Returns an empty array on any parse error rather
 * than throwing; auto-infer is best-effort.
 */
export function parseInferredMemories(text: string): string[] {
  if (text === "") return [];
  // Strip a single leading/trailing code fence if present.
  let body = text.trim();
  const fence = /^```(?:json)?\n?([\s\S]*?)\n?```$/;
  const match = fence.exec(body);
  if (match) body = match[1].trim();

  // Find the first '[' and the matching last ']', robust to leading prose.
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
