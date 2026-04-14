/**
 * Simple in-memory sliding-window rate limiter.
 *
 * Tracks call timestamps per tool name and rejects calls that would
 * exceed the configured per-minute budget. Used by {@link WebVoice}
 * when `rate_limit.per_minute` is set.
 */

/** Thrown when a tool call exceeds the per-minute budget. */
export class RateLimitError extends Error {
  readonly code = "TOOL_RATE_LIMITED";

  constructor(
    public readonly tool: string,
    public readonly limit: number,
  ) {
    super(
      `Rate limit exceeded for "${tool}": ${limit} calls/min. ` +
        "Wait before retrying.",
    );
    this.name = "RateLimitError";
  }
}

const WINDOW_MS = 60_000;

export class ToolRateLimiter {
  private readonly perMinute: number;
  private readonly windows = new Map<string, number[]>();

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }

  /**
   * Record a call for `tool`. Throws {@link RateLimitError} if the
   * sliding-window count would exceed the configured limit.
   */
  check(tool: string): void {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;

    let timestamps = this.windows.get(tool);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(tool, timestamps);
    }

    // Evict expired entries from the front.
    while (timestamps.length > 0 && (timestamps[0] ?? 0) <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.perMinute) {
      throw new RateLimitError(tool, this.perMinute);
    }

    timestamps.push(now);
  }

  /** Clear all tracked state. Useful in tests. */
  reset(): void {
    this.windows.clear();
  }
}
