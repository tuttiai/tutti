import { describe, it, expect } from "vitest";
import { FilesystemVoice } from "../src/index.js";

describe("PathSanitizer via filesystem tools", () => {
  const voice = new FilesystemVoice();
  const ctx = { session_id: "s1", agent_name: "test" };

  it("blocks path traversal to /etc/passwd", async () => {
    const readFile = voice.tools.find((t) => t.name === "read_file")!;
    const result = await readFile.execute(
      { path: "/etc/passwd", encoding: "utf-8" },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks path traversal to /etc/shadow", async () => {
    const readFile = voice.tools.find((t) => t.name === "read_file")!;
    const result = await readFile.execute(
      { path: "/etc/shadow", encoding: "utf-8" },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks access to ~/.ssh via write_file", async () => {
    const writeFile = voice.tools.find((t) => t.name === "write_file")!;
    const result = await writeFile.execute(
      { path: "~/.ssh/authorized_keys", content: "malicious", append: false },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks /proc access via list_directory", async () => {
    const listDir = voice.tools.find((t) => t.name === "list_directory")!;
    const result = await listDir.execute(
      { path: "/proc", recursive: false },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks /dev access via delete_file", async () => {
    const deleteFile = voice.tools.find((t) => t.name === "delete_file")!;
    const result = await deleteFile.execute(
      { path: "/dev/null", require_confirmation: false },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks traversal in move_file source", async () => {
    const moveFile = voice.tools.find((t) => t.name === "move_file")!;
    const result = await moveFile.execute(
      { source: "/etc/passwd", destination: "/tmp/stolen", overwrite: false },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("blocks traversal in search_files directory", async () => {
    const searchFiles = voice.tools.find((t) => t.name === "search_files")!;
    const result = await searchFiles.execute(
      { directory: "/proc/self", pattern: "root", case_sensitive: false },
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("system path not allowed");
  });

  it("allows normal paths", async () => {
    const readFile = voice.tools.find((t) => t.name === "read_file")!;
    const result = await readFile.execute(
      { path: "./package.json", encoding: "utf-8" },
      ctx,
    );
    // Should not be a sanitization error (may fail for other reasons like file not found)
    if (result.is_error) {
      expect(result.content).not.toContain("system path not allowed");
      expect(result.content).not.toContain("Path traversal");
    }
  });
});
