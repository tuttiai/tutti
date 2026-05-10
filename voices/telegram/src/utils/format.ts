/**
 * Convert any error thrown by telegraf into a fix-hint-friendly string
 * for ToolResult.content. Telegraf throws `TelegramError` with
 * `description` and `code` fields; generic errors fall back to message.
 */
export function telegramErrorMessage(err: unknown, context: string): string {
  if (err && typeof err === "object") {
    const maybe = err as { description?: string; code?: number; message?: string };
    if (typeof maybe.description === "string") {
      const code = maybe.code !== undefined ? ` [${maybe.code}]` : "";
      return `Telegram error${code} for ${context}: ${maybe.description}`;
    }
    if (typeof maybe.message === "string") {
      return `Telegram error for ${context}: ${maybe.message}`;
    }
  }
  return `Telegram error for ${context}: ${String(err)}`;
}

/**
 * Shorten user-facing text for log/error messages without leaking the
 * full conversation. Pure formatting — never used on input that goes
 * back to the LLM.
 */
export function truncate(text: string, max: number = 80): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}
