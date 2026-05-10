import { WhatsAppApiError } from "../graph-client.js";

/**
 * Convert any error thrown by the Graph client into a fix-hint-friendly
 * string for ToolResult.content. Specifically maps the 24h-window
 * error (131047) to a plain explanation, since that's the most common
 * footgun for first-time WhatsApp bot authors.
 */
export function whatsappErrorMessage(err: unknown, context: string): string {
  if (err instanceof WhatsAppApiError) {
    if (err.isReengagementWindowExpired) {
      return (
        "WhatsApp 24h window expired for " +
        context +
        ". Free-form replies are only allowed within 24 hours of the user's last inbound message. " +
        "Outside that window, use `send_template_message` with a pre-approved Message Template " +
        "(register one at Meta App → WhatsApp → Message Templates)."
      );
    }
    return `${err.message} (context: ${context})`;
  }
  if (err && typeof err === "object" && typeof (err as { message?: string }).message === "string") {
    return `WhatsApp error for ${context}: ${(err as { message: string }).message}`;
  }
  return `WhatsApp error for ${context}: ${String(err)}`;
}
