/**
 * Provider-call retry policy.
 *
 * Only {@link ProviderError} is retried — every other failure propagates
 * immediately, because a validation or permission error will not succeed on a
 * second attempt and retrying it just costs the caller time.
 */

import { ProviderError, RateLimitError } from "../errors.js";
import { logger } from "../logger.js";

/** Maximum attempts, including the first, before a provider error propagates. */
export const MAX_PROVIDER_RETRIES = 3;

/**
 * Run a provider call, retrying transient provider failures.
 *
 * A {@link RateLimitError} carrying `retryAfter` waits exactly that long,
 * honouring the provider's own guidance. Anything else backs off
 * exponentially — 1s, 2s, 4s — capped at 8 seconds.
 *
 * @param fn - The provider call to attempt.
 * @returns Whatever `fn` resolves to.
 * @throws The last error when attempts are exhausted, or immediately for any non-provider error.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_PROVIDER_RETRIES || !(err instanceof ProviderError)) {
        throw err;
      }
      if (err instanceof RateLimitError && err.retryAfter) {
        const retryAfter = err.retryAfter;
        logger.warn({ attempt, retryAfter }, "Rate limited, waiting before retry");
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      } else {
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        logger.warn({ attempt, delayMs }, "Provider error, retrying with backoff");
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
}
