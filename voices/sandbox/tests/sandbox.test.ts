import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import type { ToolContext, VoiceContext } from "@tuttiai/types";
import { SandboxVoice } from "../src/index.js";
import { createRunCodeTool } from "../src/tools/run-code.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

const voiceCtx: VoiceContext = {
  session_id: "voice-test-" + Date.now(),
  agent_name: "test-agent",
};

// ── SandboxVoice ─────────────────────────────────────────────

describe("SandboxVoice", () => {
  let voice: SandboxVoice;

  afterEach(async () => {
    if (voice) await voice.teardown();
  });

  it("has no tools before setup", () => {
    voice = new SandboxVoice();
    expect(voice.name).toBe("sandbox");
    expect(voice.required_permissions).toEqual(["shell"]);
    expect(voice.tools).toHaveLength(0);
  });

  it("creates 4 tools after setup", async () => {
    voice = new SandboxVoice();
    await voice.setup(voiceCtx);

    expect(voice.tools).toHaveLength(4);
    const names = voice.tools.map((t) => t.name);
    expect(names).toContain("run_code");
    expect(names).toContain("sandbox_read_file");
    expect(names).toContain("sandbox_write_file");
    expect(names).toContain("install_package");
  });

  it("teardown removes the sandbox directory", async () => {
    voice = new SandboxVoice();
    await voice.setup(voiceCtx);

    // Get the sandbox root before teardown.
    const runCode = voice.tools.find((t) => t.name === "run_code");
    const r = await runCode!.execute(
      runCode!.parameters.parse({ code: "pwd", language: "bash" }),
      ctx,
    );
    const dir = r.content.split("\n").find((l) => l.startsWith("stdout:"))
      ?.replace("stdout:", "")
      .trim();

    await voice.teardown();
    if (dir) expect(existsSync(dir)).toBe(false);
  });

  it("passes allowedPackages through to install_package", async () => {
    voice = new SandboxVoice({ allowedPackages: ["lodash"] });
    await voice.setup(voiceCtx);

    const install = voice.tools.find((t) => t.name === "install_package");
    const result = await install!.execute(
      install!.parameters.parse({ name: "express" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not in the allowed list");
  });

  it("run_code uses the sandbox as working_dir", async () => {
    voice = new SandboxVoice();
    await voice.setup(voiceCtx);

    // Write a file then read it from run_code.
    const write = voice.tools.find((t) => t.name === "sandbox_write_file");
    await write!.execute(
      write!.parameters.parse({ path: "data.txt", content: "hello" }),
      ctx,
    );

    const run = voice.tools.find((t) => t.name === "run_code");
    const r = await run!.execute(
      run!.parameters.parse({ code: "cat data.txt", language: "bash" }),
      ctx,
    );
    expect(r.content).toContain("hello");
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
