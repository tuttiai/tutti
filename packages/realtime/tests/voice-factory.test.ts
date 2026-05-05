import { describe, expect, it } from "vitest";

import type { ToolContext } from "@tuttiai/types";

import { RealtimeVoice } from "../src/voice-factory.js";
import type { RealtimeConfig } from "../src/types.js";

const config: RealtimeConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "sage",
  turnDetection: { type: "server_vad", threshold: 0.4 },
};

const ctx: ToolContext = { session_id: "s1", agent_name: "concierge" };

describe("RealtimeVoice", () => {
  it("returns a Voice with name 'realtime' and the network permission", () => {
    const voice = RealtimeVoice(config);
    expect(voice.name).toBe("realtime");
    expect(voice.required_permissions).toEqual(["network"]);
  });

  it("exposes a single start_realtime_session tool", () => {
    const voice = RealtimeVoice(config);
    expect(voice.tools).toHaveLength(1);
    expect(voice.tools[0]?.name).toBe("start_realtime_session");
  });

  it("the tool returns the realtime session config as its payload", async () => {
    const voice = RealtimeVoice(config);
    const tool = voice.tools[0];
    if (!tool) throw new Error("expected tool");

    const result = await tool.execute({}, ctx);
    const payload = JSON.parse(result.content);
    expect(payload).toMatchObject({
      status: "ready",
      model: config.model,
      voice: config.voice,
      turn_detection: config.turnDetection,
    });
  });

  it("the tool forwards an instructions override into the payload", async () => {
    const voice = RealtimeVoice(config);
    const tool = voice.tools[0];
    if (!tool) throw new Error("expected tool");

    const result = await tool.execute({ instructions: "Be terse." }, ctx);
    const payload = JSON.parse(result.content);
    expect(payload.instructions).toBe("Be terse.");
  });

  it("the tool's parameters schema rejects non-string instructions", () => {
    const voice = RealtimeVoice(config);
    const tool = voice.tools[0];
    if (!tool) throw new Error("expected tool");

    expect(() => tool.parameters.parse({ instructions: 7 })).toThrow();
  });
});
