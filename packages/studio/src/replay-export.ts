import type { ChatMessage, SessionSummary } from "./api.js";

/**
 * Serialise a session + its turns as a JSON string. Mirrors
 * `exportJSON` in `@tuttiai/cli`'s replay-render so the studio's
 * download is byte-comparable to the CLI's `export json` command.
 */
export function exportJSON(session: SessionSummary, turns: ChatMessage[]): string {
  return JSON.stringify(
    {
      id: session.id,
      agent_name: session.agent_name,
      started_at: session.started_at,
      messages: turns,
    },
    null,
    2,
  );
}

/**
 * Serialise a session + its turns as a Markdown document. Same layout
 * as the CLI's `export md` so users can paste either into a PR.
 */
export function exportMarkdown(session: SessionSummary, turns: ChatMessage[]): string {
  const lines: string[] = [];
  lines.push(`# Session ${session.id}`);
  lines.push("");
  lines.push(`**Agent:** ${session.agent_name}`);
  lines.push(`**Started:** ${session.started_at}`);
  lines.push(`**Model:** ${session.model}`);
  lines.push(`**Status:** ${session.status}`);
  lines.push(`**Messages:** ${turns.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (let i = 0; i < turns.length; i++) {
    const msg = turns[i];
    if (!msg) continue;
    lines.push(`## Turn ${i} (${msg.role})`);
    lines.push("");
    if (typeof msg.content === "string") {
      lines.push(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === "text") {
          lines.push(block.text);
        } else if (block.type === "tool_use") {
          lines.push(`**Tool call:** \`${block.name}\``);
          lines.push("```json");
          lines.push(JSON.stringify(block.input, null, 2));
          lines.push("```");
        } else if (block.type === "tool_result") {
          const label = block.is_error ? "**Tool error:**" : "**Tool result:**";
          lines.push(label);
          lines.push("```");
          lines.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2));
          lines.push("```");
        }
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Trigger a browser download of `text` under `filename`. */
export function downloadFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Free the blob URL on the next tick — Safari needs the click to land first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
