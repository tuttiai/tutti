import { describe, it, expect, vi } from "vitest";
import { PerKeySerialQueue } from "../src/per-chat-queue.js";

function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("PerKeySerialQueue", () => {
  it("processes items for the same key serially in FIFO order", async () => {
    const order: string[] = [];
    const q = new PerKeySerialQueue<string>(async (key, item) => {
      order.push(`${key}:${item}`);
      await flush();
    });
    q.enqueue("chat-1", "a");
    q.enqueue("chat-1", "b");
    q.enqueue("chat-1", "c");
    await q.drainAll();
    expect(order).toEqual(["chat-1:a", "chat-1:b", "chat-1:c"]);
  });

  it("processes different keys concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const q = new PerKeySerialQueue<number>(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight--;
    });
    for (let i = 0; i < 5; i++) {
      q.enqueue(`chat-${i}`, i);
    }
    await q.drainAll();
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("rejects enqueue when the per-key queue is at capacity", async () => {
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const q = new PerKeySerialQueue<number>(async () => {
      await blocked;
    }, 2);
    expect(q.enqueue("chat-1", 1)).toBe(true); // immediately drains (worker awaits)
    expect(q.enqueue("chat-1", 2)).toBe(true);
    expect(q.enqueue("chat-1", 3)).toBe(true);
    expect(q.enqueue("chat-1", 4)).toBe(false); // queue holds 2, item 1 is in flight
    release();
    await q.drainAll();
  });

  it("a thrown processor does not strand later items", async () => {
    const seen: number[] = [];
    const q = new PerKeySerialQueue<number>(async (_key, item) => {
      seen.push(item);
      if (item === 2) throw new Error("boom");
    });
    q.enqueue("c", 1);
    q.enqueue("c", 2);
    q.enqueue("c", 3);
    await q.drainAll();
    expect(seen).toEqual([1, 2, 3]);
  });

  it("rejects non-positive capacity", () => {
    expect(() => new PerKeySerialQueue<number>(async () => {}, 0)).toThrow(RangeError);
    expect(() => new PerKeySerialQueue<number>(async () => {}, -1)).toThrow(RangeError);
  });

  it("drainAll resolves when nothing is queued", async () => {
    const q = new PerKeySerialQueue<number>(vi.fn());
    await expect(q.drainAll()).resolves.toBeUndefined();
  });
});
