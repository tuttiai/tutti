/**
 * Format any error thrown by imapflow / nodemailer / mailparser into a
 * fix-hint-friendly string for ToolResult.content. Both libs throw
 * `Error` subclasses with `.message` and sometimes `.code` (e.g.
 * 'EAUTH'); generic errors fall back to message.
 */
export function emailErrorMessage(err: unknown, context: string): string {
  if (err && typeof err === "object") {
    const maybe = err as { code?: string; message?: string };
    if (typeof maybe.code === "string" && typeof maybe.message === "string") {
      return `Email error [${maybe.code}] for ${context}: ${maybe.message}`;
    }
    if (typeof maybe.message === "string") {
      return `Email error for ${context}: ${maybe.message}`;
    }
  }
  return `Email error for ${context}: ${String(err)}`;
}

/** Cap a snippet for tool output. Pure formatting — never echoed to the LLM as input. */
export function snippet(text: string, max: number = 200): string {
  if (!text) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1) + "…";
}
