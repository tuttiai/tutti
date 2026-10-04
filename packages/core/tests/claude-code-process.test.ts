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

describe("runClaudeCode with a signal", () => {
  it("kills the process when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = runClaudeCode({
      command: process.execPath,
      args: ["-e", "setInterval(()=>{},1000)"],
      stdin: "",
      timeout_ms: 5_000,
      cwd: process.cwd(),
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result).toMatchObject({ aborted: true, timed_out: false, exit_code: null });
  });

  it("never starts the process when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    // A missing binary would report ENOENT had anything been spawned.
    const result = await runClaudeCode({
      command: "definitely-not-a-claude-binary",
      args: [],
      stdin: "",
      timeout_ms: 5_000,
      cwd: process.cwd(),
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    expect(result.spawn_error).toBeUndefined();
  });

  it("leaves aborted unset on a run that finished normally", async () => {
    const result = await runClaudeCode({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      stdin: "",
      timeout_ms: 5_000,
      cwd: process.cwd(),
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({ exit_code: 0, stdout: "ok" });
    expect(result.aborted).toBeUndefined();
  });
});
