/**
 * Per-key serial queue. One worker drains each key's queue in order;
 * keys are independent and run concurrently. Used by the inbox to
 * guarantee that messages from a single chat are processed serially
 * (so the agent's reply to message N is sent before processing
 * message N+1) while different chats progress in parallel.
 */
export class PerKeySerialQueue<T> {
  private readonly queues = new Map<string, T[]>();
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly process: (key: string, item: T) => Promise<void>,
    private readonly maxPerKey: number = 10,
  ) {
    if (maxPerKey <= 0) {
      throw new RangeError("PerKeySerialQueue: maxPerKey must be positive.");
    }
  }

  /**
   * Enqueue `item` under `key`. Returns true if accepted, false if the
   * key's queue is at capacity (caller should treat as backpressure /
   * drop). Triggers an asynchronous drain on the first non-empty
   * enqueue.
   */
  enqueue(key: string, item: T): boolean {
    const existing = this.queues.get(key);
    if (existing) {
      if (existing.length >= this.maxPerKey) return false;
      existing.push(item);
      // Already draining or about to — no-op.
      void this.drain(key);
      return true;
    }
    this.queues.set(key, [item]);
    void this.drain(key);
    return true;
  }

  private async drain(key: string): Promise<void> {
    if (this.inFlight.has(key)) return;
    this.inFlight.add(key);
    try {
      let queue = this.queues.get(key);
      while (queue && queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        try {
          await this.process(key, item);
        } catch {
          // Per the inbox contract, errors are surfaced via events and
          // the optional onError sink — never as queue failures.
          // Continue draining so a failing message doesn't strand the
          // chat.
        }
        queue = this.queues.get(key);
      }
      this.queues.delete(key);
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Wait until every key's queue has fully drained. Useful in tests. */
  async drainAll(): Promise<void> {
    while (this.queues.size > 0 || this.inFlight.size > 0) {
      await Promise.resolve();
      // One microtask is usually enough; the loop guards against missed
      // wake-ups when a process() call schedules new enqueues.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** For tests and diagnostics — total queued items across all keys. */
  get _depth(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
