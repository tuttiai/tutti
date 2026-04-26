/** Format a number with commas (e.g. 12345 → "12,345"). */
export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Truncate a string to a max length, appending "..." if cut. */
export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** Render a Stripe Unix timestamp as an ISO string. */
export function formatTime(unix: number | null | undefined): string {
  if (!unix) return "unknown";
  return new Date(unix * 1000).toISOString();
}

// Currency codes whose smallest unit is the major unit itself (no decimals).
// Stripe stores amounts in the minor unit (e.g. cents); zero-decimal
// currencies are stored as the whole unit.
const ZERO_DECIMAL = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** Format a Stripe minor-unit amount (cents) into a human-readable string. */
export function formatAmount(amount: number, currency: string): string {
  const upper = currency.toUpperCase();
  if (ZERO_DECIMAL.has(upper)) {
    return `${formatNumber(amount)} ${upper}`;
  }
  const major = amount / 100;
  // Use Intl when we can — it picks the right decimal places per currency
  // and avoids floating-point drift for most amounts. Falls back to a
  // fixed 2-decimal string if the runtime rejects the currency code.
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: upper,
    }).format(major);
  } catch {
    return `${major.toFixed(2)} ${upper}`;
  }
}

/** "1 customer" / "2 customers" — pluralise based on count. */
export function pluralise(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : plural ?? singular + "s";
}

/** Add the Stripe-test-mode marker if not livemode. */
export function modeBadge(livemode: boolean): string {
  return livemode ? "" : " [test]";
}

/** Format dollar-shaped Stripe metadata into a one-line summary. */
export function formatMetadata(metadata: Record<string, string> | null | undefined): string {
  if (!metadata) return "";
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "";
  return ` · metadata: ${entries.map(([k, v]) => `${k}=${truncate(v, 40)}`).join(", ")}`;
}

/**
 * Format a Stripe SDK error into a descriptive, user-fixable message.
 * Stripe throws `StripeError` subclasses with `type`, `rawType`, `code`,
 * `statusCode`, `requestId`, `param`, `decline_code`, `doc_url`.
 */
export function stripeErrorMessage(error: unknown, context?: string): string {
  const where = context ? ` for ${context}` : "";
  if (error instanceof Error) {
    const e = error as {
      type?: string;
      rawType?: string;
      code?: string;
      statusCode?: number;
      requestId?: string;
      param?: string;
      decline_code?: string;
      doc_url?: string;
    };

    const requestId = e.requestId ? ` (request ${e.requestId})` : "";
    const docs = e.doc_url ? `\nDocs: ${e.doc_url}` : "";
    const statusPrefix = e.statusCode ? `[${e.statusCode}] ` : "";

    if (e.type === "StripeAuthenticationError") {
      return `${statusPrefix}Stripe authentication failed${where}${requestId}.\nCheck STRIPE_SECRET_KEY — the key may be wrong, revoked, or for the wrong account/mode (test vs live).`;
    }
    if (e.type === "StripePermissionError") {
      return `${statusPrefix}Stripe rejected the request${where}${requestId}.\nThe API key lacks permission for this resource. Restricted keys must explicitly grant the operation.${docs}`;
    }
    if (e.type === "StripeRateLimitError") {
      return `${statusPrefix}Stripe rate limit exceeded${where}${requestId}.\nSlow down and retry; live keys allow ~100 read / 100 write per second by default.`;
    }
    if (e.type === "StripeIdempotencyError") {
      return `${statusPrefix}Stripe idempotency error${where}${requestId}.\n${error.message}`;
    }
    if (e.type === "StripeInvalidRequestError") {
      const param = e.param ? ` (param: ${e.param})` : "";
      return `${statusPrefix}Stripe rejected the request${where}${param}${requestId}: ${error.message}${docs}`;
    }
    if (e.type === "StripeCardError") {
      const decline = e.decline_code ? ` (decline_code: ${e.decline_code})` : "";
      return `${statusPrefix}Card error${where}${decline}${requestId}: ${error.message}${docs}`;
    }
    if (e.type === "StripeAPIError") {
      return `${statusPrefix}Stripe server error${where}${requestId}: ${error.message}\nThis is on Stripe's side. Retry with backoff; if it persists, see status.stripe.com.`;
    }
    if (e.type === "StripeConnectionError") {
      return `${statusPrefix}Could not reach Stripe${where}${requestId}: ${error.message}\nCheck network connectivity and outbound TLS.`;
    }

    return `${statusPrefix}Stripe error${where}${requestId}: ${error.message}${docs}`;
  }
  return String(error);
}
