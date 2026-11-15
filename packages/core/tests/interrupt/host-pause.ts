/**
 * Helpers for the host-pause tests: one runtime that is frozen (a laptop
 * asleep, a VM paused, a sandbox hibernated) and then woken, with its memory
 * intact. Unlike the restart tests, no second process takes over; the clock
 * just jumps past every timeout while nothing in the process runs.
 */

import { vi } from "vitest";
import type { ChatResponse, LLMProvider, TuttiEventType } from "@tuttiai/types";

import type { TuttiRuntime } from "../../src/runtime.js";
import { createMockProvider } from "../helpers/mock-provider.js";

/** The moment every host-pause test starts at. */
export const FROZEN_AT = new Date("2026-11-12T22:00:00Z");

/** One hour in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/** One day in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/**
 * Take over the clock so a later {@link wake} can move it. Call it before
 * `boot`, so every timer the runtime starts is a fake one. Microtasks and
 * `nextTick` stay real, so promises still settle while the host is frozen.
 *
 * @param at - The wall-clock time the host starts at.
 */
export function freezeHost(at: Date = FROZEN_AT): void {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(at);
}

/**
 * Wake the host after a pause of `gapMs`: the clock moves on by the gap and
 * every timer that fell due while it was frozen fires, in order, as they do
 * when a stopped process or a paused VM is resumed.
 *
 * @param gapMs - How long the host was frozen.
 */
export async function wake(gapMs: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(gapMs);
}

/** A provider whose chat call number `holdAt` waits until {@link HeldProvider.open}. */
export interface HeldProvider {
  /** The provider; `chat` is a vitest spy. */
  provider: LLMProvider & { chat: ReturnType<typeof vi.fn> };
  /** Settles once the held call has started, so the run is inside it. */
  held: Promise<void>;
  /** Lets the held call return its response. */
  open: () => void;
}

/**
 * A provider that answers `responses` in order but holds one call back, so a
 * test can freeze the host while a run waits on the model.
 *
 * @param responses - The responses, in call order.
 * @param holdAt - Zero-based index of the call to hold.
 * @returns The provider and its controls.
 */
export function heldProvider(responses: ChatResponse[], holdAt: number): HeldProvider {
  const inner = createMockProvider(responses);
  let started = (): void => undefined;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => (started = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const chat = vi.fn(async (...args: Parameters<LLMProvider["chat"]>): Promise<ChatResponse> => {
    const index = calls++;
    if (index === holdAt) {
      started();
      await gate;
    }
    // Safe: createMockProvider's chat always resolves to one of `responses`.
    return (await inner.chat(...args)) as ChatResponse;
  });
  return { provider: { ...inner, chat }, held, open: () => release() };
}

/**
 * Count the events of the given types a runtime emits from now on.
 *
 * @param runtime - The runtime to listen to.
 * @param types - The event types to count.
 * @returns A live count per type, starting at zero.
 */
export function countEvents(runtime: TuttiRuntime, types: TuttiEventType[]): Map<TuttiEventType, number> {
  const counts = new Map<TuttiEventType, number>(types.map((type) => [type, 0]));
  for (const type of types) {
    runtime.events.on(type, () => counts.set(type, (counts.get(type) ?? 0) + 1));
  }
  return counts;
}
