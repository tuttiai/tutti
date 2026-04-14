import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import type { ToolContext, VoiceContext } from "@tuttiai/types";
import { SandboxVoice } from "../src/index.js";
import { createExecuteCodeTool } from "../src/tools/run-code.js";

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
    expect(names).toContain("execute_code");
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("install_package");
  });

  it("teardown removes the sandbox directory", async () => {
    voice = new SandboxVoice();
    await voice.setup(voiceCtx);

    const exec = voice.tools.find((t) => t.name === "execute_code");
    const r = await exec!.execute(
      exec!.parameters.parse({ code: "pwd", language: "bash" }),
      ctx,
    );
    const dir = r.content.split("\n").find((l) => l.startsWith("stdout:"))
      ?.replace("stdout:", "")
      .trim();

    await voice.teardown();
    if (dir) expect(existsSync(dir)).toBe(false);
  });

  it("passes allowed_packages through to install_package", async () => {
    voice = new SandboxVoice({ allowed_packages: ["lodash"] });
    await voice.setup(voiceCtx);

    const install = voice.tools.find((t) => t.name === "install_package");
    const result = await install!.execute(
      install!.parameters.parse({ name: "express" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not in the allowed list");
  });

  it("execute_code uses the sandbox as working_dir", async () => {
    voice = new SandboxVoice();
    await voice.setup(voiceCtx);

    const write = voice.tools.find((t) => t.name === "write_file");
    await write!.execute(
      write!.parameters.parse({ path: "data.txt", content: "hello" }),
      ctx,
    );

    const exec = voice.tools.find((t) => t.name === "execute_code");
    const r = await exec!.execute(
      exec!.parameters.parse({ code: "cat data.txt", language: "bash" }),
      ctx,
    );
    expect(r.content).toContain("hello");
  });

  it("allowed_languages restricts execute_code", async () => {
    voice = new SandboxVoice({ allowed_languages: ["python"] });
    await voice.setup(voiceCtx);

    const exec = voice.tools.find((t) => t.name === "execute_code");
    // "bash" is not in the allowed list — Zod validation rejects it.
    expect(() =>
      exec!.parameters.parse({ code: "echo hi", language: "bash" }),
    ).toThrow();

    // "python" is allowed.
    const input = exec!.parameters.parse({
      code: 'print("ok")',
      language: "python",
    });
    const r = await exec!.execute(input, ctx);
    expect(r.content).toContain("ok");
  });

  it("max_file_size_bytes limits write_file", async () => {
    voice = new SandboxVoice({ max_file_size_bytes: 10 });
    await voice.setup(voiceCtx);

    const write = voice.tools.find((t) => t.name === "write_file");
    const result = await write!.execute(
      write!.parameters.parse({ path: "big.txt", content: "x".repeat(100) }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("too large");
  });
});

// ── execute_code tool (standalone) ───────────────────────────

describe("execute_code tool", () => {
  const tool = createExecuteCodeTool();

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
