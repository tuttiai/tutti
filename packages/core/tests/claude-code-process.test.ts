/**
 * Unit tests for {@link runClaudeCode}, the default process runner. They
 * start `node` itself in place of the CLI, so no Claude Code is needed.
 */

import { describe, it, expect } from "vitest";

import { runClaudeCode } from "../src/providers/claude-code-process.js";

function run(script: string, extra: { stdin?: string; timeout_ms?: number; command?: string } = {}) {
  return runClaudeCode({
    command: extra.command ?? process.execPath,
    args: ["-e", script],
    stdin: extra.stdin ?? "",
    timeout_ms: extra.timeout_ms ?? 5_000,
    cwd: process.cwd(),
  });
}

describe("runClaudeCode", () => {
  it("feeds stdin and captures stdout, stderr and the exit code", async () => {
    const result = await run(
      "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.toUpperCase());process.stderr.write('warn');process.exit(3)})",
      { stdin: "hello" },
    );
    expect(result).toMatchObject({ exit_code: 3, stdout: "HELLO", stderr: "warn", timed_out: false });
  });

  it("kills a run that exceeds its timeout", async () => {
    const result = await run("setInterval(()=>{},1000)", { timeout_ms: 100 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBeNull();
  });

  it("reports a missing binary as a spawn error rather than rejecting", async () => {
    const result = await run("", { command: "definitely-not-a-claude-binary" });
    expect(result.spawn_error?.code).toBe("ENOENT");
  });
});
