import { describe, it, expect } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { SandboxVoice } from "../src/index.js";
import { createRunCodeTool } from "../src/tools/run-code.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

// ── SandboxVoice ─────────────────────────────────────────────

describe("SandboxVoice", () => {
  it("implements the Voice interface with 1 tool", () => {
    const voice = new SandboxVoice();
    expect(voice.name).toBe("sandbox");
    expect(voice.required_permissions).toEqual(["shell"]);
    expect(voice.tools).toHaveLength(1);
    expect(voice.tools[0]?.name).toBe("run_code");
  });

  it("passes options through to the tool", () => {
    const voice = new SandboxVoice({ timeout_ms: 5_000 });
    expect(voice.tools).toHaveLength(1);
  });
});

// ── run_code tool ────────────────────────────────────────────

describe("run_code tool", () => {
  const tool = createRunCodeTool();

  it("runs bash and returns output", async () => {
    const input = tool.parameters.parse({
      code: 'echo "tool test"',
      language: "bash",
    });
    const result = await tool.execute(input, ctx);

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("tool test");
    expect(result.content).toContain("exit_code: 0");
  });

  it("returns is_error for non-zero exit", async () => {
    const input = tool.parameters.parse({
      code: "exit 1",
      language: "bash",
    });
    const result = await tool.execute(input, ctx);

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("exit_code: 1");
  });

  it("includes duration_ms in output", async () => {
    const input = tool.parameters.parse({
      code: "true",
      language: "bash",
    });
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("duration_ms:");
  });

  it("reports truncation when output is large", async () => {
    const input = tool.parameters.parse({
      code: "python3 -c \"print('x' * 20480)\"",
      language: "bash",
    });
    const result = await tool.execute(input, ctx);
    expect(result.content).toContain("truncated to 10 KB");
  });

  it("validates language parameter", () => {
    expect(() =>
      tool.parameters.parse({ code: "x", language: "ruby" }),
    ).toThrow();
  });

  it("validates timeout_ms upper bound", () => {
    expect(() =>
      tool.parameters.parse({
        code: "x",
        language: "bash",
        timeout_ms: 999_999,
      }),
    ).toThrow();
  });
});
