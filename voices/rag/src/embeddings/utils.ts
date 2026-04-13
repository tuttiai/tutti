/** Shared helpers for embedding providers: retry, batching, normalisation. */

export class EmbeddingRequestError extends Error {
  public readonly code = "EMBEDDING_REQUEST_FAILED";
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EmbeddingRequestError";
  }
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Whether a rejection represents a retryable rate-limit / transient error.
 * Retry on HTTP 408, 429, and 5xx. Any other error is propagated immediately.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof EmbeddingRequestError && error.status !== undefined) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  // Unknown fetch/network failures are treated as transient — one-shot DNS /
  // socket hiccups shouldn't take down a whole ingestion pipeline.
  return error instanceof TypeError;
}

/**
 * Run `fn` with exponential backoff on retryable errors.
 *
 * Sleep uses `setTimeout` — in tests, vitest fake timers plus
 * `vi.advanceTimersByTimeAsync` drive this deterministically.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number = DEFAULT_MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      const delay = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split an array into windows of at most `size`. */
export function batch<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error("batch size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Return `v` scaled to unit Euclidean length.
 *
 * Zero vectors are passed through unchanged — dividing by zero would
 * produce NaNs downstream.
 */
export function normalize(v: number[]): number[] {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  if (sumSq === 0) return v.slice();
  const inv = 1 / Math.sqrt(sumSq);
  return v.map((x) => x * inv);
}
