import type { InboxRateLimitConfig } from "./types.js";

/** Default rate limit applied when none is configured: 30 msg / 60s with burst 10. */
export const DEFAULT_RATE_LIMIT: InboxRateLimitConfig = {
  messagesPerWindow: 30,
  windowMs: 60_000,
  burst: 10,
};

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/**
 * Per-key token-bucket rate limit. Each `key` (typically a
 * `platform_user_id`) has its own bucket of `capacity` (= `burst`)
 * tokens, refilled at `messagesPerWindow / windowMs` tokens per
 * millisecond. {@link allow} returns true when a token was available
 * and consumed, false otherwise.
 *
 * Buckets are created lazily and live in a Map; call {@link gc}
 * periodically to evict idle keys. The orchestrator runs `gc` on a
 * timer, but tests can call it manually.
 */
export class TokenBucketRateLimit {
  private readonly buckets = new Map<string, BucketState>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly disabled: boolean;
  private readonly idleEvictionMs: number;

  constructor(config: InboxRateLimitConfig | undefined = DEFAULT_RATE_LIMIT) {
    if ("disabled" in config && config.disabled) {
      this.disabled = true;
      this.capacity = 0;
      this.refillPerMs = 0;
      this.idleEvictionMs = 0;
      return;
    }
    const cfg = config as Exclude<InboxRateLimitConfig, { disabled: true }>;
    if (cfg.windowMs <= 0 || cfg.messagesPerWindow <= 0) {
      throw new RangeError(
        "TokenBucketRateLimit: windowMs and messagesPerWindow must both be positive.",
      );
    }
    this.disabled = false;
    this.capacity = cfg.burst ?? cfg.messagesPerWindow;
    this.refillPerMs = cfg.messagesPerWindow / cfg.windowMs;
    // Evict buckets idle for ≥ 2 windows — far past the point where
    // refilling would have already filled them to capacity.
    this.idleEvictionMs = cfg.windowMs * 2;
  }

  /**
   * Try to consume one token for `key`. Returns true on success, false
   * when the bucket is empty.
   */
  allow(key: string, now: number = Date.now()): boolean {
    if (this.disabled) return true;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefillMs;
      if (elapsed > 0) {
        bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
        bucket.lastRefillMs = now;
      }
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /** Remove buckets idle past the eviction threshold. Cheap, runs in O(n). */
  gc(now: number = Date.now()): void {
    if (this.disabled) return;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefillMs > this.idleEvictionMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** For tests and diagnostics — number of buckets currently tracked. */
  get _size(): number {
    return this.buckets.size;
  }
}
