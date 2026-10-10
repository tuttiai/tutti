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
      tool_timeout_ms: undefined,
      context: undefined,
      require_approval: undefined,
    });
  });

  it("reads the context variables that are set, and only those", () => {
    const env = readStartAgentEnv(reader({ TUTTI_MAX_TOOL_RESULT_CHARS: "8000", TUTTI_SUMMARISE_AFTER_TOKENS: "120000" }));
    expect(env.context).toEqual({ max_tool_result_chars: 8000, summarise_after_tokens: 120000 });
  });

  it("reads all three context variables", () => {
    const env = readStartAgentEnv(reader({
      TUTTI_MAX_TOOL_RESULT_CHARS: "8000",
      TUTTI_TRIM_AFTER_TOKENS: "40000",
      TUTTI_SUMMARISE_AFTER_TOKENS: "120000",
    }));
    expect(env.context).toEqual({ max_tool_result_chars: 8000, trim_after_tokens: 40000, summarise_after_tokens: 120000 });
  });

  it("refuses a context variable that is not a positive integer", () => {
    expect(() => readStartAgentEnv(reader({ TUTTI_TRIM_AFTER_TOKENS: "-5" }))).toThrow(/TUTTI_TRIM_AFTER_TOKENS/);
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
        TUTTI_TOOL_TIMEOUT_MS: "600000",
      }),
    );
    expect(env.voices).toEqual([
      { voice: "slack", options: { token: TOKEN }, only: ["list_channels"] },
      { voice: "web", options: {} },
    ]);
    expect(env.permissions).toEqual(["network", "browser"]);
    expect(env.max_turns).toBe(12);
    expect(env.max_tool_calls).toBe(40);
    expect(env.tool_timeout_ms).toBe(600000);
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
    ["TUTTI_TOOL_TIMEOUT_MS", "0"],
  ])("refuses %s=%s", (key, value) => {
    expect(() => readStartAgentEnv(reader({ [key]: value }))).toThrow(`${key} must be a positive number.`);
  });

  describe("TUTTI_REQUIRE_APPROVAL", () => {
    const approval = (value: string): unknown =>
      readStartAgentEnv(reader({ TUTTI_REQUIRE_APPROVAL: value })).require_approval;

    it("leaves the framework default when absent", () => {
      expect(readStartAgentEnv(reader({})).require_approval).toBeUndefined();
    });

    it.each(["", "  ", "destructive", " destructive "])(
      "reads %j as the framework default",
      (value) => {
        expect(approval(value)).toBeUndefined();
      },
    );

    it("reads none as gating nothing", () => {
      expect(approval("none")).toBe(false);
    });

    it("reads all as gating every tool", () => {
      expect(approval(" all ")).toBe("all");
    });

    it("reads a list, trimmed, with empty items dropped", () => {
      expect(approval(" send_*, ,create_pull_request,, web.fetch-url")).toEqual([
        "send_*",
        "create_pull_request",
        "web.fetch-url",
      ]);
    });

    it("refuses ?, which the matcher would read as a literal rather than the wildcard it looks like", () => {
      expect(() => approval("send_?")).toThrow('TUTTI_REQUIRE_APPROVAL names "send_?"');
    });

    it("reads a single tool name as a list of one", () => {
      expect(approval("create_issue")).toEqual(["create_issue"]);
    });

    it("reads a list of nothing but commas as the framework default", () => {
      expect(approval(" , ,")).toBeUndefined();
    });

    it("refuses an item that is not a tool name or glob, quoting only that item", () => {
      let message = "";
      try {
        approval(`send_*, bogus!, ${TOKEN}`);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('TUTTI_REQUIRE_APPROVAL names "bogus!"');
      expect(message).not.toContain("send_*");
      expect(message).not.toContain(TOKEN);
    });

    it.each(["rm -rf", "a/b", "tool;drop", "all,[x]"])("refuses %j", (value) => {
      expect(() => approval(value)).toThrow(/TUTTI_REQUIRE_APPROVAL names/);
    });
  });
});
