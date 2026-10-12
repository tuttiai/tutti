/** Default most sessions a bounded store holds at once. */
export const DEFAULT_MAX_SESSIONS = 1_000;

/** Default time a session may sit unused before it is evicted: 24 hours. */
export const DEFAULT_SESSION_IDLE_TTL_MS = 86_400_000;

/** Bounds shared by the session stores that keep sessions in this process. */
export interface SessionStoreBounds {
  /** Most sessions held at once; over it, the least recently used is evicted. Default 1000. */
  max_sessions?: number;
  /** Evict a session unused for this long, in milliseconds. Default 24 hours. */
  idle_ttl_ms?: number;
  /** Clock, for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * Tracks when each session was last used, in least-recently-used order, and
 * says which to evict. It holds ids only: the store that owns it keeps the
 * sessions and is told through `onEvict` to drop one.
 */
export class SessionLru {
  /** Insertion order is use order: the first entry is the least recently used. */
  private readonly usedAt = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly onEvict: (id: string) => void;
  /** The clock the bounds are measured with. */
  readonly now: () => number;

  /**
   * @param bounds - Cap, idle time to live and clock.
   * @param onEvict - Called once for every id evicted, so the owner can drop it.
   */
  constructor(bounds: SessionStoreBounds, onEvict: (id: string) => void) {
    this.maxSessions = Math.max(1, bounds.max_sessions ?? DEFAULT_MAX_SESSIONS);
    this.idleTtlMs = bounds.idle_ttl_ms ?? DEFAULT_SESSION_IDLE_TTL_MS;
    this.now = bounds.now ?? Date.now;
    this.onEvict = onEvict;
  }

  /**
   * Stop tracking an id without evicting it, so `onEvict` is not called.
   *
   * @param id - The session id.
   */
  forget(id: string): void {
    this.usedAt.delete(id);
  }

  /**
   * Whether an id is tracked and has not sat idle past the time to live.
   * One that has is evicted here.
   *
   * @param id - The session id.
   * @returns True when the session may still be used.
   */
  isLive(id: string): boolean {
    const at = this.usedAt.get(id);
    if (at === undefined) return false;
    if (this.now() - at <= this.idleTtlMs) return true;
    this.evict(id);
    return false;
  }

  /**
   * Mark an id used, then evict whatever is idle too long or over the cap.
   *
   * @param id - The session id.
   * @param at - When it was used. Default now; a restart passes the time last written.
   */
  touch(id: string, at: number = this.now()): void {
    this.usedAt.delete(id);
    this.usedAt.set(id, at);
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, at] of this.usedAt) {
      const idle = now - at > this.idleTtlMs;
      if (!idle && this.usedAt.size <= this.maxSessions) break;
      this.evict(id);
    }
  }

  private evict(id: string): void {
    this.usedAt.delete(id);
    this.onEvict(id);
  }
}
