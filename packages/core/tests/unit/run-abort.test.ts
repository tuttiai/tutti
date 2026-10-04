import { describe, it, expect, vi } from "vitest";

import { RunAbortedError } from "../../src/errors.js";
import { abortable, abortError, raceAbort, throwIfAborted, withSignal } from "../../src/run-abort.js";

function aborted(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe("run-abort", () => {
  describe("abortError", () => {
    it("carries a string reason", () => {
      expect(abortError(aborted("client disconnected")).reason).toBe("client disconnected");
    });

    it("carries an Error reason's message", () => {
      expect(abortError(aborted(new Error("timed out"))).reason).toBe("timed out");
    });

    it("describes a signal aborted with no reason of its own", () => {
      const error = abortError(aborted());
      expect(error).toBeInstanceOf(RunAbortedError);
      expect(error.message).toContain("Run aborted:");
    });

    it("redacts a secret in the reason", () => {
      const error = abortError(aborted("key sk-ant-abcdefghijklmnopqrstuvwxyz0123"));
      expect(error.message).not.toContain("sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    });
  });

  describe("throwIfAborted", () => {
    it("does nothing without a signal or before an abort", () => {
      expect(() => throwIfAborted(undefined)).not.toThrow();
      expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    });

    it("throws RunAbortedError once aborted", () => {
      expect(() => throwIfAborted(aborted("gone"))).toThrow(RunAbortedError);
    });
  });

  describe("raceAbort", () => {
    it("resolves with the work when nothing aborts", async () => {
      await expect(raceAbort(Promise.resolve(7), new AbortController().signal)).resolves.toBe(7);
    });

    it("rejects and releases the work when the signal aborts first", async () => {
      const controller = new AbortController();
      const onAbort = vi.fn();
      const race = raceAbort(new Promise<never>(() => undefined), controller.signal, onAbort);
      controller.abort("gone");
      await expect(race).rejects.toBeInstanceOf(RunAbortedError);
      expect(onAbort).toHaveBeenCalledOnce();
    });

    it("rejects at once on a signal that is already aborted", async () => {
      const onAbort = vi.fn();
      await expect(raceAbort(Promise.resolve(1), aborted("gone"), onAbort)).rejects.toBeInstanceOf(RunAbortedError);
      expect(onAbort).toHaveBeenCalledOnce();
    });
  });

  describe("abortable", () => {
    it("never starts the work on an aborted signal", async () => {
      const work = vi.fn(() => Promise.resolve(1));
      await expect(abortable(aborted("gone"), work)).rejects.toBeInstanceOf(RunAbortedError);
      expect(work).not.toHaveBeenCalled();
    });

    it("runs the work without a signal", async () => {
      await expect(abortable(undefined, () => Promise.resolve(2))).resolves.toBe(2);
    });
  });

  describe("withSignal", () => {
    it("adds the signal to a copy of the request", () => {
      const request = { messages: [] };
      const signal = new AbortController().signal;
      expect(withSignal(request, signal)).toEqual({ messages: [], signal });
      expect(request).not.toHaveProperty("signal");
    });

    it("returns the request unchanged without a signal", () => {
      const request = { messages: [] };
      expect(withSignal(request, undefined)).toBe(request);
    });
  });
});
