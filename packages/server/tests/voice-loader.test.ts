import { describe, it, expect, vi } from "vitest";
import type { Voice } from "@tuttiai/types";
import { z } from "zod";

import { loadVoices, narrowVoice, VoiceConfigError } from "../src/voice-loader.js";
import { fromSchema, type VoiceLoader } from "../src/voice-registry.js";

const TOKEN = "ghp_do_not_echo_this_000000000000000000";

function fakeVoice(name: string, tools: string[], hooks: Partial<Voice> = {}): Voice {
  return {
    name,
    required_permissions: ["network"],
    tools: tools.map((tool) => ({
      name: tool,
      description: tool,
      parameters: z.object({}),
      execute: async () => ({ content: "ok" }),
    })),
    ...hooks,
  };
}

const FakeSchema = z.object({ token: z.string().min(1).optional(), port: z.number().optional() }).strict();

function loaders(): Map<string, VoiceLoader> {
  return new Map<string, VoiceLoader>([
    ["fake", async () => fromSchema(FakeSchema, () => fakeVoice("fake", ["read", "write", "delete"]))],
    ["other", async () => fromSchema(FakeSchema, () => fakeVoice("other", ["ping"]))],
    [
      "absent",
      async () => {
        throw new Error("Cannot find package '@tuttiai/absent'");
      },
    ],
  ]);
}

describe("loadVoices", () => {
  it("builds every listed voice", async () => {
    const voices = await loadVoices(
      [
        { voice: "fake", options: { token: TOKEN } },
        { voice: "other", options: {} },
      ],
      loaders(),
    );
    expect(voices.map((voice) => voice.name)).toEqual(["fake", "other"]);
    expect(voices[0]?.tools.map((tool) => tool.name)).toEqual(["read", "write", "delete"]);
  });

  it("returns no voices for an empty list", async () => {
    await expect(loadVoices([], loaders())).resolves.toEqual([]);
  });

  it("narrows a voice to the tools named in only", async () => {
    const [voice] = await loadVoices([{ voice: "fake", options: {}, only: ["read"] }], loaders());
    expect(voice?.tools.map((tool) => tool.name)).toEqual(["read"]);
  });

  it("refuses an unknown voice and lists the known ones", async () => {
    await expect(loadVoices([{ voice: "../../evil", options: {} }], loaders())).rejects.toThrow(
      /Unknown voice "\.\.\/\.\.\/evil"\. This image carries: fake, other, absent/,
    );
  });

  it("refuses a voice whose package is not in the image", async () => {
    await expect(loadVoices([{ voice: "absent", options: {} }], loaders())).rejects.toThrow(
      'Voice "absent" is not installed in this image.',
    );
  });

  it("refuses a voice listed twice", async () => {
    const specs = [
      { voice: "fake", options: {} },
      { voice: "fake", options: {} },
    ];
    await expect(loadVoices(specs, loaders())).rejects.toThrow(/listed more than once/);
  });

  it("refuses an unknown option, naming the field", async () => {
    await expect(loadVoices([{ voice: "fake", options: { tokenn: "x" } }], loaders())).rejects.toThrow(
      /refused its options: \(options\) \(unrecognized_keys\)/,
    );
  });

  it("never quotes an option's value in a refusal", async () => {
    const error: unknown = await loadVoices(
      [{ voice: "fake", options: { token: TOKEN, port: TOKEN } }],
      loaders(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoiceConfigError);
    expect(String(error)).toContain("port (invalid_type)");
    expect(String(error)).not.toContain(TOKEN);
  });
});

describe("narrowVoice", () => {
  it("refuses a tool name the voice does not have", () => {
    expect(() => narrowVoice(fakeVoice("fake", ["read"]), ["read", "raed"])).toThrow(
      /no tool named "raed"\.\nIts tools are: read/,
    );
  });

  it("keeps the voice's lifecycle bound to the original", async () => {
    const original = fakeVoice("fake", ["read", "write"]);
    const setup = vi.fn(async function (this: Voice) {
      expect(this).toBe(original);
    });
    const teardown = vi.fn(async () => undefined);
    original.setup = setup;
    original.teardown = teardown;
    original.description = "described";

    const narrowed = narrowVoice(original, ["read"]);
    await narrowed.setup?.({ session_id: "s", agent_name: "a" });
    await narrowed.teardown?.();

    expect(setup).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledOnce();
    expect(narrowed.description).toBe("described");
    expect(narrowed.required_permissions).toEqual(["network"]);
  });

  it("narrows a voice whose tools are built in setup once setup has run", async () => {
    const late = fakeVoice("late", []);
    late.setup = async function (this: Voice) {
      this.tools = fakeVoice("late", ["run", "install"]).tools;
    };

    const narrowed = narrowVoice(late, ["run"]);
    expect(narrowed.tools).toEqual([]);
    await narrowed.setup?.({ session_id: "s", agent_name: "a" });

    expect(narrowed.tools.map((tool) => tool.name)).toEqual(["run"]);
  });

  it("refuses an unknown name on a setup-built voice when setup runs", async () => {
    const late = fakeVoice("late", []);
    late.setup = async function (this: Voice) {
      this.tools = fakeVoice("late", ["run"]).tools;
    };

    const narrowed = narrowVoice(late, ["rn"]);
    await expect(narrowed.setup?.({ session_id: "s", agent_name: "a" })).rejects.toThrow(VoiceConfigError);
  });
});
