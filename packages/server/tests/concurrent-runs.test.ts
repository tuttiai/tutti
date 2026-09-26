/**
 * Two requests on one server share one runtime and one event bus. These
 * tests prove each request only ever sees the events of its own run.
 */

import { afterEach, describe, expect, it } from "vitest";

import { API_KEY, buildTestServer } from "./helpers.js";
import {
  createEchoVoice,
  createRendezvous,
  createTaggedProvider,
} from "./concurrent-provider.js";
import { parseSSE } from "./sse.js";

type App = Awaited<ReturnType<typeof buildTestServer>>["app"];

function post(app: App, url: string, input: string): ReturnType<App["inject"]> {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${API_KEY}` },
    payload: { input },
  });
}

/** Every text-bearing field of a frame, so a foreign tag cannot hide anywhere. */
function frameText(frame: Record<string, unknown>): string {
  return JSON.stringify(frame);
}

describe("concurrent runs on one server", () => {
  let app: App | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  describe("POST /run/stream", () => {
    it("streams each request only the frames of its own run", async () => {
      const meet = createRendezvous(2);
      ({ app } = await buildTestServer([], {
        provider: createTaggedProvider("tool-then-text", meet),
        agent: { streaming: true, voices: [createEchoVoice(meet)] },
      }));

      const [alpha, bravo] = await Promise.all([
        post(app, "/run/stream", "alpha"),
        post(app, "/run/stream", "bravo"),
      ]);

      for (const [tag, other, res] of [
        ["alpha", "bravo", alpha],
        ["bravo", "alpha", bravo],
      ] as const) {
        const frames = parseSSE(res.payload);
        const complete = frames.find((f) => f.event === "run_complete");
        expect(complete?.output).toBe(`${tag}:a ${tag}:b`);

        const names = frames.map((f) => f.event);
        expect(names.filter((n) => n === "turn_start")).toHaveLength(2);
        expect(names.filter((n) => n === "turn_end")).toHaveLength(2);
        expect(names.filter((n) => n === "tool_call")).toHaveLength(1);
        expect(names.filter((n) => n === "tool_result")).toHaveLength(1);

        const deltas = frames.filter((f) => f.event === "content_delta").map((f) => f.text);
        expect(deltas).toEqual([`${tag}:thinking `, `${tag}:a `, `${tag}:b`]);

        const toolResult = frames.find((f) => f.event === "tool_result");
        expect(toolResult?.content).toBe(`echo:${tag}`);

        for (const frame of frames) {
          expect(frameText(frame)).not.toContain(other);
          if (frame.event === "turn_start" || frame.event === "turn_end") {
            expect(frame.session_id).toBe(complete?.session_id);
          }
        }
      }
    });

    it("does not stream a run started outside the request", async () => {
      const meet = createRendezvous(2);
      const harness = await buildTestServer([], {
        provider: createTaggedProvider("tool-then-text", meet),
        agent: { streaming: true, voices: [createEchoVoice(meet)] },
      });
      app = harness.app;

      const [res, background] = await Promise.all([
        post(app, "/run/stream", "alpha"),
        harness.runtime.run("test-agent", "bravo"),
      ]);

      expect(background.output).toBe("bravo:a bravo:b");
      expect(res.payload).not.toContain("bravo");
      expect(res.payload).toContain("alpha:b");
    });
  });

  describe("POST /run timeout", () => {
    it("returns each request only its own partial_output", async () => {
      const meet = createRendezvous(2);
      ({ app } = await buildTestServer([], {
        provider: createTaggedProvider("hang-after-partial", meet),
        agent: { streaming: true },
        config: { timeout_ms: 100 },
      }));

      const [alpha, bravo] = await Promise.all([
        post(app, "/run", "alpha"),
        post(app, "/run", "bravo"),
      ]);

      expect(alpha.statusCode).toBe(504);
      expect(bravo.statusCode).toBe(504);
      expect(alpha.json().partial_output).toBe("alpha:partial");
      expect(bravo.json().partial_output).toBe("bravo:partial");
    });
  });
});
