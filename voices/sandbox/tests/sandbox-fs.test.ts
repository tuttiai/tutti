import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import type { ToolContext } from "@tuttiai/types";
import { SessionSandbox, SandboxEscapeError } from "../src/sandbox.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("test-" + Date.now());
  await sandbox.init();
});

afterEach(async () => {
  await sandbox.destroy();
});

// ── SessionSandbox.resolve — path traversal prevention ───────

describe("SessionSandbox.resolve", () => {
  it("resolves a simple relative path inside the sandbox", () => {
    const resolved = sandbox.resolve("file.txt");
    expect(resolved.startsWith(sandbox.root)).toBe(true);
  });

  it("resolves nested relative paths", () => {
    const resolved = sandbox.resolve("sub/dir/file.txt");
    expect(resolved.startsWith(sandbox.root)).toBe(true);
  });

  it("throws SandboxEscapeError for ../../etc/passwd", () => {
    expect(() => sandbox.resolve("../../etc/passwd")).toThrow(
      SandboxEscapeError,
    );
  });

  it("throws SandboxEscapeError for absolute paths outside sandbox", () => {
    expect(() => sandbox.resolve("/etc/passwd")).toThrow(
      SandboxEscapeError,
    );
  });

  it("throws SandboxEscapeError for ../ escape", () => {
    expect(() => sandbox.resolve("../outside")).toThrow(
      SandboxEscapeError,
    );
  });

  it("throws SandboxEscapeError for symlink-style traversal", () => {
    expect(() => sandbox.resolve("sub/../../..")).toThrow(
      SandboxEscapeError,
    );
  });

  it("allows resolving the sandbox root itself", () => {
    // sandbox.resolve(".") should resolve to sandbox.root.
    const resolved = sandbox.resolve(".");
    expect(resolved).toBe(sandbox.root);
  });

  it("does not match a prefix collision (abcdef vs abc)", () => {
    // If sandbox root is /tmp/tutti-sandbox/test-123, then
    // a path resolving to /tmp/tutti-sandbox/test-1234 should fail.
    expect(() => sandbox.resolve("../" + sandbox.root.split("/").pop() + "4/evil")).toThrow(
      SandboxEscapeError,
    );
  });

  it("SandboxEscapeError has the correct code", () => {
    try {
      sandbox.resolve("../../etc/shadow");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxEscapeError);
      expect((err as SandboxEscapeError).code).toBe("SANDBOX_ESCAPE");
    }
  });

  it("SandboxEscapeError message does not leak the host path", () => {
    try {
      sandbox.resolve("../../etc/shadow");
      expect.unreachable();
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain("/tmp/");
      expect(msg).not.toContain("tutti-sandbox");
    }
  });
});

// ── SessionSandbox lifecycle ─────────────────────────────────

describe("SessionSandbox lifecycle", () => {
  it("creates the directory on init", async () => {
    expect(existsSync(sandbox.root)).toBe(true);
  });

  it("removes the directory on destroy", async () => {
    const root = sandbox.root;
    await sandbox.destroy();
    expect(existsSync(root)).toBe(false);
  });

  it("init is idempotent", async () => {
    await sandbox.init(); // second call — should not throw
    expect(existsSync(sandbox.root)).toBe(true);
  });
});

// ── read_file ────────────────────────────────────────

describe("read_file", () => {
  it("reads a file from the sandbox", async () => {
    const tool = createReadFileTool(sandbox);
    const writeTool = createWriteFileTool(sandbox);

    await writeTool.execute(
      writeTool.parameters.parse({ path: "hello.txt", content: "world" }),
      ctx,
    );

    const result = await tool.execute(
      tool.parameters.parse({ path: "hello.txt" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("world");
  });

  it("returns is_error for nonexistent file", async () => {
    const tool = createReadFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "nope.txt" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
  });

  it("rejects path traversal", async () => {
    const tool = createReadFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "../../etc/passwd" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("escapes the sandbox");
  });
});

// ── write_file ───────────────────────────────────────

describe("write_file", () => {
  it("writes a file to the sandbox", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "output.txt", content: "data" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("output.txt");

    const onDisk = readFileSync(sandbox.resolve("output.txt"), "utf-8");
    expect(onDisk).toBe("data");
  });

  it("creates nested directories", async () => {
    const tool = createWriteFileTool(sandbox);
    await tool.execute(
      tool.parameters.parse({ path: "a/b/c.txt", content: "deep" }),
      ctx,
    );

    expect(existsSync(sandbox.resolve("a/b/c.txt"))).toBe(true);
  });

  it("rejects path traversal", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ path: "../outside.txt", content: "evil" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("escapes the sandbox");
  });

  it("rejects files exceeding max_file_size_bytes", async () => {
    const tool = createWriteFileTool(sandbox, 16);
    const result = await tool.execute(
      tool.parameters.parse({ path: "big.txt", content: "x".repeat(100) }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("too large");
    expect(result.content).toContain("16 byte limit");
  });

  it("allows files under the size limit", async () => {
    const tool = createWriteFileTool(sandbox, 1024);
    const result = await tool.execute(
      tool.parameters.parse({ path: "ok.txt", content: "small" }),
      ctx,
    );
    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("ok.txt");
  });
});
