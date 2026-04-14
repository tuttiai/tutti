/**
 * End-to-end test: creates a sandbox, writes a TypeScript file that
 * computes the first 10 Fibonacci numbers, executes it, and verifies
 * the output contains 55.
 */

import { describe, it, expect, afterEach } from "vitest";
import type { ToolContext, VoiceContext } from "@tuttiai/types";
import { SandboxVoice } from "../src/index.js";

const ctx: ToolContext = {
  session_id: "e2e-test",
  agent_name: "test-agent",
};

describe("end-to-end: Fibonacci", () => {
  let voice: SandboxVoice;

  afterEach(async () => {
    if (voice) await voice.teardown();
  });

  it("writes, executes, and reads a TypeScript Fibonacci result", async () => {
    voice = new SandboxVoice();

    const voiceCtx: VoiceContext = {
      session_id: "e2e-fib-" + Date.now(),
      agent_name: "test-agent",
    };
    await voice.setup(voiceCtx);

    const write = voice.tools.find((t) => t.name === "write_file")!;
    const exec = voice.tools.find((t) => t.name === "execute_code")!;
    const read = voice.tools.find((t) => t.name === "read_file")!;

    // 1. Execute TypeScript that computes Fibonacci and writes to a file.
    //    The sandbox root is the working_dir, so writeFileSync("fib.txt")
    //    writes into the sandbox.
    const fibCode = [
      'import { writeFileSync } from "node:fs";',
      "",
      "function fib(n: number): number[] {",
      "  const seq: number[] = [0, 1];",
      "  for (let i = 2; i < n; i++) {",
      "    seq.push(seq[i - 1]! + seq[i - 2]!);",
      "  }",
      "  return seq;",
      "}",
      "",
      "const result = fib(11);",
      "console.log(result.join(', '));",
      'writeFileSync("fib-output.txt", result.join(", "));',
    ].join("\n");

    const execResult = await exec.execute(
      exec.parameters.parse({ code: fibCode, language: "typescript" }),
      ctx,
    );

    expect(execResult.content).toContain("exit_code: 0");
    // fib(11) = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55]
    expect(execResult.content).toContain("55");

    // 2. Read the output file that the script wrote.
    const readResult = await read.execute(
      read.parameters.parse({ path: "fib-output.txt" }),
      ctx,
    );

    expect(readResult.is_error).toBeUndefined();
    expect(readResult.content).toContain("55");
    expect(readResult.content).toBe("0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55");

    // 3. Write a data file, then execute code that reads it.
    const writeResult = await write.execute(
      write.parameters.parse({ path: "input.txt", content: "42" }),
      ctx,
    );
    expect(writeResult.is_error).toBeUndefined();

    const readBack = await exec.execute(
      exec.parameters.parse({
        code: 'import { readFileSync } from "node:fs";\nconsole.log("input:", readFileSync("input.txt", "utf-8"));',
        language: "typescript",
      }),
      ctx,
    );
    expect(readBack.content).toContain("input: 42");
  });

  it("restricts languages via allowed_languages", async () => {
    voice = new SandboxVoice({ allowed_languages: ["python"] });

    const voiceCtx: VoiceContext = {
      session_id: "e2e-lang-" + Date.now(),
      agent_name: "test-agent",
    };
    await voice.setup(voiceCtx);

    const exec = voice.tools.find((t) => t.name === "execute_code")!;

    // Python is allowed.
    const pyResult = await exec.execute(
      exec.parameters.parse({ code: "print(55)", language: "python" }),
      ctx,
    );
    expect(pyResult.content).toContain("55");
    expect(pyResult.content).toContain("exit_code: 0");

    // Bash is not allowed — Zod validation rejects it.
    expect(() =>
      exec.parameters.parse({ code: "echo hi", language: "bash" }),
    ).toThrow();
  });
});
