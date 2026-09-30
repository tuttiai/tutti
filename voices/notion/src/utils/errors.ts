import { SecretsManager } from "@tuttiai/core";

/** Notion's own refusal sentence is passed on, but never at any length. */
const MESSAGE_LIMIT = 300;
/** Both shapes of Notion integration secret, in case one is echoed that is not the configured token. */
const NOTION_SECRET = /\b(?:ntn|secret)_[A-Za-z0-9]{20,}/g;

const SHARE_HINT =
  "Either the id is wrong, or it has not been shared with this integration: open it in Notion, choose the ••• menu, then Connections, and add the integration.";

/**
 * Remove the token, any other Notion secret and any key `SecretsManager` knows from a sentence.
 *
 * @param text - The sentence that may carry a secret.
 * @param token - The configured token, scrubbed whatever shape it has.
 * @returns The sentence with every secret replaced by `[REDACTED]`.
 */
export function scrubSecrets(text: string, token: string): string {
  const withoutToken = token.length > 0 ? text.split(token).join("[REDACTED]") : text;
  return SecretsManager.redact(withoutToken.replace(NOTION_SECRET, "[REDACTED]"));
}

/** What Notion said about a refusal, read from its `{ object: "error", code, message }` body. */
export interface NotionRefusal {
  readonly status: number;
  readonly code: string | undefined;
  readonly message: string | undefined;
  readonly retryAfter: string | null;
}

/** Notion's own sentence, shortened and scrubbed, or nothing when it sent none. */
function saidBy(refusal: NotionRefusal, token: string): string {
  if (refusal.message === undefined || refusal.message.length === 0) return "";
  return `: ${scrubSecrets(refusal.message, token).slice(0, MESSAGE_LIMIT)}`;
}

/** The fix for a refusal, keyed by Notion's error code first and its status second. */
function hintFor(refusal: NotionRefusal): string {
  const { status, code } = refusal;
  if (status === 401 || code === "unauthorized") {
    return "Notion refused the integration token. Set the voice's token, or NOTION_TOKEN, to a current internal integration secret (ntn_... or secret_...) from https://www.notion.so/profile/integrations.";
  }
  if (status === 404 || code === "object_not_found") return `Notion could not find it. ${SHARE_HINT}`;
  if (status === 403 || code === "restricted_resource") {
    return "The integration lacks the capability this needs. In the integration's settings, enable the content capabilities (read, update, insert) the tool uses.";
  }
  if (status === 429 || code === "rate_limited") {
    const wait = refusal.retryAfter === null ? "a few seconds" : `${refusal.retryAfter} seconds`;
    return `Notion's rate limit was reached (about three requests a second). Wait ${wait} and try again.`;
  }
  if (status === 409 || code === "conflict_error") return "Notion reported a conflicting edit. Read the page again and retry.";
  if (status === 400) return "Notion rejected the request as invalid. Check the ids and the shape of any properties, filter or sorts.";
  if (status >= 500) return `Notion is having trouble (${status}). Try again shortly; if it persists, see https://status.notion.so.`;
  return `Notion answered ${status}.`;
}

/**
 * The sentence handed to the model for a refusal: where it happened, the fix, and Notion's own
 * words, with every secret scrubbed.
 *
 * @param refusal - What Notion answered.
 * @param what - What the call was about, such as `page 0123…`.
 * @param token - The configured token, scrubbed from Notion's words.
 * @returns The sentence.
 */
export function refusalMessage(refusal: NotionRefusal, what: string, token: string): string {
  return `${hintFor(refusal)} (${what}${saidBy(refusal, token)})`;
}

/** The sentence for a voice given no token and finding no NOTION_TOKEN either. */
export const MISSING_TOKEN_MESSAGE =
  "The Notion voice is not configured. Pass `token`, or set NOTION_TOKEN, to an internal integration secret from https://www.notion.so/profile/integrations, then share each page or database with the integration through its Connections menu in Notion.";
