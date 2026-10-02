import { describe, it, expect, afterEach } from "vitest";
import type { Voice, VoiceContext } from "@tuttiai/types";

import { buildTestServer, textResponse, API_KEY } from "./helpers.js";
import { conversationOf } from "../src/routes/schemas.js";

/**
 * A run's `conversation_id`, carried from the request body to each voice's
 * `setup()`, so a voice such as the sandbox can keep its state across the
 * runs of one conversation while each has a session of its own.
 */

/** A voice that records the context each run sets it up with. */
function recordingVoice(seen: VoiceContext[]): Voice {
  return {
    name: "recording",
    required_permissions: [],
    tools: [],
    setup: async (context) => {
      seen.push(context);
    },
  };
}

describe("conversation_id", () => {
  let app: Awaited<ReturnType<typeof buildTestServer>>["app"] | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("reaches the voices of a streamed run", async () => {
    const seen: VoiceContext[] = [];
    ({ app } = await buildTestServer([textResponse("Done.")], { agent: { voices: [recordingVoice(seen)] } }));
    const res = await app.inject({ method: "POST", url: "/run/stream", headers: { authorization: `Bearer ${API_KEY}` }, payload: { input: "hello", conversation_id: "conv-7f3a" } });
    expect(res.statusCode).toBe(200);
    expect(seen.at(0)?.conversation_id).toBe("conv-7f3a");
  });

  it("reaches the voices of a run answered whole", async () => {
    const seen: VoiceContext[] = [];
    ({ app } = await buildTestServer([textResponse("Done.")], { agent: { voices: [recordingVoice(seen)] } }));
    const res = await app.inject({ method: "POST", url: "/run", headers: { authorization: `Bearer ${API_KEY}` }, payload: { input: "hello", conversation_id: "conv-7f3a" } });
    expect(res.statusCode).toBe(200);
    expect(seen.at(0)?.conversation_id).toBe("conv-7f3a");
  });

  it("is left out of the context when the request names none", async () => {
    const seen: VoiceContext[] = [];
    ({ app } = await buildTestServer([textResponse("Done.")], { agent: { voices: [recordingVoice(seen)] } }));
    await app.inject({ method: "POST", url: "/run", headers: { authorization: `Bearer ${API_KEY}` }, payload: { input: "hello" } });
    expect(seen.at(0)).not.toHaveProperty("conversation_id");
  });

  it("refuses an id a voice could not safely build a path from", async () => {
    ({ app } = await buildTestServer([textResponse("Done.")]));
    for (const conversation_id of ["../../etc", "a/b", "", "x".repeat(129)]) {
      const res = await app.inject({ method: "POST", url: "/run", headers: { authorization: `Bearer ${API_KEY}` }, payload: { input: "hello", conversation_id } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("conversationOf", () => {
  it("answers the run options for a body that names a conversation, and nothing otherwise", () => {
    expect(conversationOf({ conversation_id: "c-1" })).toEqual({ conversation_id: "c-1" });
    expect(conversationOf({})).toBeUndefined();
  });
});
