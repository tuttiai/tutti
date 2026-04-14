import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";

/** Parse raw SSE text into an array of event objects. */
function parseSSE(raw: string): Record<string, unknown>[] {
  return raw
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => {
      const dataLine = frame
        .split("\n")
        .find((l) => l.startsWith("data: "));
      if (!dataLine) return undefined;
      return JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
    })
    .filter((e): e is Record<string, unknown> => e !== undefined);
}

describe("POST /run/stream", () => {
  let app: ReturnType<typeof buildTestServer>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("returns SSE content-type and ends with run_complete", async () => {
    ({ app } = buildTestServer([textResponse("Streamed!")]));

    const res = await app.inject({
      method: "POST",
      url: "/run/stream",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hello" },
    });

    expect(res.headers["content-type"]).toContain("text/event-stream");

    const events = parseSSE(res.payload);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const last = events[events.length - 1];
    expect(last).toBeDefined();
    expect(last!.event).toBe("run_complete");
    expect(last!.output).toBe("Streamed!");
    expect(typeof last!.session_id).toBe("string");
    expect(typeof last!.cost_usd).toBe("number");
    expect(typeof last!.duration_ms).toBe("number");
  });

  it("emits turn_start and turn_end events", async () => {
    ({ app } = buildTestServer([textResponse("OK")]));

    const res = await app.inject({
      method: "POST",
      url: "/run/stream",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hello" },
    });

    const events = parseSSE(res.payload);
    const names = events.map((e) => e.event);

    expect(names).toContain("turn_start");
    expect(names).toContain("turn_end");
  });

  it("returns 400 when input is missing", async () => {
    ({ app } = buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run/stream",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 401 without Authorization header", async () => {
    ({ app } = buildTestServer([textResponse("unused")]));

    const res = await app.inject({
      method: "POST",
      url: "/run/stream",
      payload: { input: "hello" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("emits an error event when the runtime throws", async () => {
    const harness = buildTestServer([]);
    app = harness.app;

    harness.runtime.run = () => Promise.reject(new Error("boom"));

    const res = await app.inject({
      method: "POST",
      url: "/run/stream",
      headers: { authorization: `Bearer ${API_KEY}` },
      payload: { input: "hello" },
    });

    const events = parseSSE(res.payload);
    const errEvent = events.find((e) => e.event === "error");
    expect(errEvent).toBeDefined();
    expect(errEvent!.message).toBe("boom");
  });
});
