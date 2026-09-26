import { describe, it, expect, afterEach } from "vitest";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";
import { parseSSE } from "./sse.js";

/**
 * `/run/stream` over a real socket, not `app.inject`.
 *
 * The route once treated the request's `close` event as the client leaving.
 * On a real socket Node emits that as soon as the body has been read, so every
 * reply was ended before its first frame and a client got `200` with an empty
 * body. `inject` never emits it, which is why every other stream test passed.
 * The listener is on loopback and in-process: no request leaves the machine.
 */
describe("POST /run/stream over a real socket", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("delivers the frames and ends with run_complete", async () => {
    ({ app } = await buildTestServer([textResponse("Over the wire")]));
    const address = await app.listen({ port: 0, host: "127.0.0.1" });

    const res = await fetch(`${address}/run/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "hello" }),
    });

    expect(res.status).toBe(200);
    const events = parseSSE(await res.text());
    const names = events.map((e) => e.event);
    expect(names).toContain("turn_start");
    expect(events.at(-1)?.event).toBe("run_complete");
    expect(events.at(-1)?.output).toBe("Over the wire");
  });
});
