import type { ChatMessage, ContentBlock, ToolResultBlock } from "@tuttiai/types";

/** Roughly how many characters one token covers, for estimating without a tokenizer. */
const CHARS_PER_TOKEN = 4;

const TRIM_NOTE = "[Shortened to save context. Call the tool again if you need the rest.]";

/*
 * What a shortened result keeps from its end. A result reaches the history
 * wrapped by PromptGuard, which closes it with "[END TOOL RESULT]" and a
 * reminder to follow only the original task; cutting those off would leave
 * the fence open on every shortened result.
 */
const KEPT_TAIL_CHARS = 160;

/**
 * Estimate how many tokens a conversation costs to send. An approximation
 * for deciding when to shorten history, not a bill: it errs high on JSON-heavy
 * content and low on dense prose.
 *
 * @param messages - The conversation.
 * @returns The estimated token count.
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) chars += JSON.stringify(message.content).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Cap one tool result's text, keeping its start and its end. The end is kept
 * because that is where a command's error or a listing's total usually is.
 *
 * @param content - The tool result's text.
 * @param max_chars - The most characters to keep.
 * @returns The text, unchanged when it already fits.
 */
export function capText(content: string, max_chars: number): string {
  if (content.length <= max_chars) return content;
  const head = Math.ceil(max_chars * 0.7);
  const tail = max_chars - head;
  const omitted = content.length - head - tail;
  return `${content.slice(0, head)}\n[… ${String(omitted)} characters left out …]\n${tail > 0 ? content.slice(-tail) : ""}`;
}

/**
 * Cap each tool result in a turn's results.
 *
 * @param results - The tool results of one turn.
 * @param max_chars - The most characters to keep from each.
 * @returns The results, each capped.
 */
export function capToolResults(results: ToolResultBlock[], max_chars: number): ToolResultBlock[] {
  return results.map((r) => (r.content.length <= max_chars ? r : { ...r, content: capText(r.content, max_chars) }));
}

/**
 * Shorten every tool result except the most recent ones, in place, keeping
 * its start and its last characters, which hold PromptGuard's closing fence.
 * A result already shortened is left exactly as it is, so repeated calls
 * rewrite nothing a provider's cache already holds.
 *
 * @param messages - The conversation, mutated. Messages are replaced, never edited, so a caller's copies are untouched.
 * @param keep_recent - Tool results at the end never shortened.
 * @param keep_chars - Characters kept from the start of each shortened result.
 * @returns How many characters were removed.
 */
export function trimToolResults(messages: ChatMessage[], keep_recent: number, keep_chars: number): number {
  let seen = 0;
  let removed = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages.at(i);
    if (!message || typeof message.content === "string") continue;
    let changed = false;
    const blocks: ContentBlock[] = [];
    for (const block of [...message.content].reverse()) {
      if (block.type !== "tool_result") { blocks.unshift(block); continue; }
      seen++;
      const short = seen > keep_recent && !block.content.includes(TRIM_NOTE) &&
        block.content.length > keep_chars + KEPT_TAIL_CHARS + TRIM_NOTE.length + 2;
      if (!short) { blocks.unshift(block); continue; }
      const content = `${block.content.slice(0, keep_chars)}\n${TRIM_NOTE}\n${block.content.slice(-KEPT_TAIL_CHARS)}`;
      removed += block.content.length - content.length;
      blocks.unshift({ ...block, content });
      changed = true;
    }
    if (changed) messages.splice(i, 1, { ...message, content: blocks });
  }
  return removed;
}
