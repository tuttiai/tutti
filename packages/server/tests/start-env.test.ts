import { describe, it, expect } from "vitest";

import { readStartAgentEnv } from "../src/start-env.js";

const TOKEN = "xoxb-never-echoed-1234567890";

function reader(vars: Record<string, string>): (key: string) => string | undefined {
  const map = new Map(Object.entries(vars));
  return (key) => map.get(key);
}

describe("readStartAgentEnv", () => {
  it("reads nothing as no voices, no permissions and no limits", () => {
    expect(readStartAgentEnv(reader({}))).toEqual({
      voices: [],
      permissions: [],
      max_turns: undefined,
      max_tool_calls: undefined,
      max_cost_usd: undefined,
    });
  });

  it("reads voices, permissions and limits", () => {
    const env = readStartAgentEnv(
      reader({
        TUTTI_VOICES: JSON.stringify([
          { voice: "slack", options: { token: TOKEN }, only: ["list_channels"] },
          { voice: "web" },
        ]),
        TUTTI_PERMISSIONS: "network, browser",
        TUTTI_MAX_TURNS: "12",
        TUTTI_MAX_TOOL_CALLS: "40",
        TUTTI_MAX_COST_USD: "0.75",
      }),
    );
    expect(env.voices).toEqual([
      { voice: "slack", options: { token: TOKEN }, only: ["list_channels"] },
      { voice: "web", options: {} },
    ]);
    expect(env.permissions).toEqual(["network", "browser"]);
    expect(env.max_turns).toBe(12);
    expect(env.max_tool_calls).toBe(40);
    expect(env.max_cost_usd).toBe(0.75);
  });

  it("treats empty values as absent", () => {
    const env = readStartAgentEnv(reader({ TUTTI_VOICES: " ", TUTTI_PERMISSIONS: "", TUTTI_MAX_TURNS: "" }));
    expect(env.voices).toEqual([]);
    expect(env.permissions).toEqual([]);
    expect(env.max_turns).toBeUndefined();
  });

  it("reports invalid JSON without quoting it", () => {
    const read = reader({ TUTTI_VOICES: `[{"voice":"slack","options":{"token":"${TOKEN}"` });
    expect(() => readStartAgentEnv(read)).toThrow("TUTTI_VOICES is not valid JSON.");
  });

  it("reports the wrong shape by path, never by value", () => {
    const read = reader({ TUTTI_VOICES: JSON.stringify([{ voice: "slack", token: TOKEN }]) });
    let message = "";
    try {
      readStartAgentEnv(read);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("TUTTI_VOICES has the wrong shape: 0 (unrecognized_keys)");
    expect(message).not.toContain(TOKEN);
  });

  it("refuses an empty only list, which would leave a voice with no tools", () => {
    const read = reader({ TUTTI_VOICES: JSON.stringify([{ voice: "web", only: [] }]) });
    expect(() => readStartAgentEnv(read)).toThrow(/0\.only \(too_small\)/);
  });

  it("refuses a permission the framework does not have", () => {
    expect(() => readStartAgentEnv(reader({ TUTTI_PERMISSIONS: "network,root" }))).toThrow(
      /TUTTI_PERMISSIONS names "root"/,
    );
  });

  it.each([
    ["TUTTI_MAX_TURNS", "0"],
    ["TUTTI_MAX_TURNS", "2.5"],
    ["TUTTI_MAX_TOOL_CALLS", "many"],
    ["TUTTI_MAX_COST_USD", "-1"],
  ])("refuses %s=%s", (key, value) => {
    expect(() => readStartAgentEnv(reader({ [key]: value }))).toThrow(`${key} must be a positive number.`);
  });
});
