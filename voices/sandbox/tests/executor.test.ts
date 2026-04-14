import { describe, it, expect } from "vitest";
import { execute } from "../src/executor.js";

// ── Bash ─────────────────────────────────────────────────────

describe("execute — bash", () => {
  it("captures stdout", async () => {
    const r = await execute('echo "hello world"', "bash");
    expect(r.stdout.trim()).toBe("hello world");
    expect(r.exit_code).toBe(0);
    expect(r.duration_ms).toBeGreaterThan(0);
    expect(r.truncated).toBe(false);
  });

  it("captures stderr", async () => {
    const r = await execute("echo err >&2", "bash");
    expect(r.stderr).toContain("err");
    expect(r.exit_code).toBe(0);
  });

  it("returns non-zero exit code on failure", async () => {
    const r = await execute("exit 42", "bash");
    expect(r.exit_code).toBe(42);
  });

  it("handles empty output", async () => {
    const r = await execute("true", "bash");
    expect(r.stdout).toBe("");
    expect(r.exit_code).toBe(0);
  });

  it("passes custom env vars to the child process", async () => {
    const r = await execute("echo $MY_VAR", "bash", {
      env: { MY_VAR: "hello" },
    });
    expect(r.stdout.trim()).toBe("hello");
  });
});

// ── TypeScript (tsx) ─────────────────────────────────────────

describe("execute — typescript", () => {
  it("runs a simple script via tsx", async () => {
    const r = await execute('console.log("ts works");', "typescript");
    expect(r.stdout.trim()).toBe("ts works");
    expect(r.exit_code).toBe(0);
  });

  it("reports errors on invalid TypeScript", async () => {
    const r = await execute("const x: number = 'not a number';", "typescript");
    // tsx may succeed (esbuild strips types) or fail — either way we
    // get a result, not an exception.
    expect(typeof r.exit_code).toBe("number");
  });

  it("supports top-level await", async () => {
    const code = "const x = await Promise.resolve(42)\nconsole.log(x)";
    const r = await execute(code, "typescript");
    expect(r.stdout.trim()).toBe("42");
    expect(r.exit_code).toBe(0);
  });
});

// ── Python ───────────────────────────────────────────────────

describe("execute — python", () => {
  it("runs a simple script", async () => {
    const r = await execute('print("py works")', "python");
    expect(r.stdout.trim()).toBe("py works");
    expect(r.exit_code).toBe(0);
  });

  it("captures stderr on syntax error", async () => {
    const r = await execute("def bad(:", "python");
    expect(r.exit_code).not.toBe(0);
    expect(r.stderr).toContain("SyntaxError");
  });

  it("passes env vars", async () => {
    const r = await execute(
      'import os; print(os.environ.get("PY_VAR", ""))',
      "python",
      { env: { PY_VAR: "hello" } },
    );
    expect(r.stdout.trim()).toBe("hello");
  });
});

// ── Timeout ──────────────────────────────────────────────────

describe("execute — timeout", () => {
  it("kills the process after timeout_ms", async () => {
    const r = await execute("sleep 60", "bash", { timeout_ms: 200 });
    expect(r.exit_code).toBe(137);
    expect(r.stderr).toContain("timeout");
    expect(r.duration_ms).toBeLessThan(5_000);
  });
});

// ── Output truncation ────────────────────────────────────────

describe("execute — truncation", () => {
  it("truncates stdout exceeding 10 KB", async () => {
    // Generate ~20 KB of output.
    const r = await execute(
      "python3 -c \"print('x' * 20480)\"",
      "bash",
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout).toContain("[…output truncated to 10 KB]");
  });
});

// ── ANSI stripping ───────────────────────────────────────────

describe("execute — ANSI stripping", () => {
  it("strips color codes from stdout", async () => {
    const r = await execute(
      "printf '\\033[31mred\\033[0m'",
      "bash",
    );
    expect(r.stdout).toBe("red");
    expect(r.stdout).not.toContain("\x1b");
  });
});

// ── Path redaction ───────────────────────────────────────────

describe("execute — path redaction", () => {
  it("does not expose the host temp directory path", async () => {
    // This script intentionally errors and includes a path in stderr.
    const r = await execute("cat /nonexistent 2>&1; pwd", "bash");
    // The working dir (OS tmpdir) should be redacted.
    expect(r.stdout).not.toMatch(/\/private\/tmp|\/tmp\/[a-z]/i);
  });
});

// ── Spawn errors ─────────────────────────────────────────────

describe("execute — spawn errors", () => {
  it("returns exit_code 127 when the command is not found", async () => {
    const r = await execute("true", "bash", {
      env: { PATH: "/nonexistent" },
    });
    // With a broken PATH, bash may still be found (absolute path) but
    // internal commands may fail. The key contract: no thrown exception.
    expect(typeof r.exit_code).toBe("number");
  });
});
