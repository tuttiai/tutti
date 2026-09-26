import { describe, expect, it } from "vitest";
import { EventBus } from "@tuttiai/core";
import type { TuttiEvent } from "@tuttiai/types";

import { scopeRunEvents } from "../src/run-scope.js";

function token(session_id: string, text: string): TuttiEvent {
  return { type: "token:stream", agent_name: "a", session_id, text };
}

describe("scopeRunEvents", () => {
  describe("run", () => {
    it("delivers events emitted inside the scope, across awaits", async () => {
      const bus = new EventBus();
      const seen: TuttiEvent[] = [];
      const scope = scopeRunEvents(bus, (e) => seen.push(e));

      await scope.run(async () => {
        bus.emit(token("s1", "before"));
        await Promise.resolve();
        bus.emit(token("s1", "after"));
      });

      expect(seen.map((e) => (e.type === "token:stream" ? e.text : ""))).toEqual([
        "before",
        "after",
      ]);
      scope.unsubscribe();
    });

    it("ignores events emitted outside the scope", async () => {
      const bus = new EventBus();
      const seen: TuttiEvent[] = [];
      const scope = scopeRunEvents(bus, (e) => seen.push(e));

      bus.emit(token("s1", "outside"));
      await scope.run(() => Promise.resolve());

      expect(seen).toEqual([]);
      scope.unsubscribe();
    });

    it("keeps two interleaved scopes apart", async () => {
      const bus = new EventBus();
      const first: string[] = [];
      const second: string[] = [];
      const a = scopeRunEvents(bus, (e) => {
        if (e.type === "token:stream") first.push(e.text);
      });
      const b = scopeRunEvents(bus, (e) => {
        if (e.type === "token:stream") second.push(e.text);
      });

      let releaseA = (): void => {};
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      await Promise.all([
        a.run(async () => {
          bus.emit(token("s1", "a1"));
          await gateA;
          bus.emit(token("s1", "a2"));
        }),
        b.run(async () => {
          bus.emit(token("s2", "b1"));
          releaseA();
          await Promise.resolve();
          bus.emit(token("s2", "b2"));
        }),
      ]);

      expect(first).toEqual(["a1", "a2"]);
      expect(second).toEqual(["b1", "b2"]);
      a.unsubscribe();
      b.unsubscribe();
    });

    it("returns the value of the wrapped function", async () => {
      const scope = scopeRunEvents(new EventBus(), () => {});
      await expect(scope.run(() => Promise.resolve(42))).resolves.toBe(42);
      scope.unsubscribe();
    });
  });

  describe("unsubscribe", () => {
    it("stops delivery and is safe to call twice", async () => {
      const bus = new EventBus();
      const seen: TuttiEvent[] = [];
      const scope = scopeRunEvents(bus, (e) => seen.push(e));

      scope.unsubscribe();
      scope.unsubscribe();
      await scope.run(async () => {
        bus.emit(token("s1", "late"));
      });

      expect(seen).toEqual([]);
    });
  });
});
