/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/**
 * Extract the tweet ID from a twitter.com or x.com status URL.
 * Returns null if the URL is not recognisable as a tweet permalink.
 */
export function extractTweetId(url: string): string | null {
  const match = /(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/.exec(url);
  return match?.[1] ?? null;
}

/** Build a public permalink for a tweet given its ID. */
export function tweetUrl(id: string): string {
  return `https://x.com/i/web/status/${id}`;
}

/**
 * Format a Twitter API error into a descriptive, user-fixable message.
 * Uses the HTTP status code if present on the error object.
 */
export function twErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const err = error as { code?: number; data?: { title?: string; detail?: string } };
    const status = err.code;
    const statusPrefix = status ? `[${status}] ` : "";

    if (status === 401) {
      return `${statusPrefix}Twitter authentication failed${where}.\nCheck TWITTER_BEARER_TOKEN (read) or TWITTER_API_KEY/SECRET + TWITTER_ACCESS_TOKEN/SECRET (write) in your .env.`;
    }
    if (status === 403) {
      return `${statusPrefix}Twitter forbade the request${where}.\nYour app may lack the required scope (tweet.write, users.read, etc.) or the account is suspended.`;
    }
    if (status === 404) {
      return `${statusPrefix}Not found${where}.\nThe tweet or user may have been deleted, or the ID/handle is wrong.`;
    }
    if (status === 429) {
      return `${statusPrefix}Twitter rate limit exceeded${where}.\nWait before retrying, or use a higher tier of the X API.`;
    }

    const detail = err.data?.detail ?? err.data?.title;
    const base = detail ? `${error.message}: ${detail}` : error.message;
    return `${statusPrefix}Twitter API error${where}: ${base}`;
  }
  return String(error);
}
