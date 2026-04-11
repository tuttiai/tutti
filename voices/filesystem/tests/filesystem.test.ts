import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ToolContext } from "@tuttiai/types";

import { readFileTool } from "../src/tools/read-file.js";
import { writeFileTool } from "../src/tools/write-file.js";
import { listDirectoryTool } from "../src/tools/list-directory.js";
import { createDirectoryTool } from "../src/tools/create-directory.js";
import { deleteFileTool } from "../src/tools/delete-file.js";
import { moveFileTool } from "../src/tools/move-file.js";
import { searchFilesTool } from "../src/tools/search-files.js";
import { FilesystemVoice } from "../src/index.js";

let testDir: string;

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

beforeEach(() => {
  testDir = join(tmpdir(), `tutti-fs-test-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// FilesystemVoice
// ---------------------------------------------------------------------------

describe("FilesystemVoice", () => {
  it("implements the Voice interface with 7 tools", () => {
    const voice = new FilesystemVoice();
    expect(voice.name).toBe("filesystem");
    expect(voice.tools).toHaveLength(7);
    const names = voice.tools.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("create_directory");
    expect(names).toContain("delete_file");
    expect(names).toContain("move_file");
    expect(names).toContain("search_files");
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("reads a file as utf-8", async () => {
    const file = join(testDir, "hello.txt");
    writeFileSync(file, "Hello World");

    const result = await readFileTool.execute(
      readFileTool.parameters.parse({ path: file }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe("Hello World");
  });

  it("reads a file as base64", async () => {
    const file = join(testDir, "binary.bin");
    writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]));

    const result = await readFileTool.execute(
      readFileTool.parameters.parse({ path: file, encoding: "base64" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toBe(Buffer.from([0x00, 0x01, 0x02]).toString("base64"));
  });

  it("returns error for nonexistent file", async () => {
    const result = await readFileTool.execute(
      readFileTool.parameters.parse({ path: join(testDir, "nope.txt") }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("write_file", () => {
  it("creates and writes a new file", async () => {
    const file = join(testDir, "new.txt");

    const result = await writeFileTool.execute(
      writeFileTool.parameters.parse({ path: file, content: "hello" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Wrote");
    expect(readFileSync(file, "utf-8")).toBe("hello");
  });

  it("appends to an existing file", async () => {
    const file = join(testDir, "append.txt");
    writeFileSync(file, "line1\n");

    await writeFileTool.execute(
      writeFileTool.parameters.parse({ path: file, content: "line2\n", append: true }),
      ctx,
    );

    expect(readFileSync(file, "utf-8")).toBe("line1\nline2\n");
  });

  it("returns error when parent directory doesn't exist", async () => {
    const file = join(testDir, "no", "such", "dir", "file.txt");

    const result = await writeFileTool.execute(
      writeFileTool.parameters.parse({ path: file, content: "test" }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe("list_directory", () => {
  it("lists files and directories", async () => {
    writeFileSync(join(testDir, "a.txt"), "a");
    mkdirSync(join(testDir, "subdir"));

    const result = await listDirectoryTool.execute(
      listDirectoryTool.parameters.parse({ path: testDir }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("a.txt");
    expect(result.content).toContain("subdir");
    expect(result.content).toContain("file");
    expect(result.content).toContain("dir");
  });

  it("filters by glob pattern", async () => {
    writeFileSync(join(testDir, "hello.ts"), "code");
    writeFileSync(join(testDir, "readme.md"), "docs");

    const result = await listDirectoryTool.execute(
      listDirectoryTool.parameters.parse({ path: testDir, pattern: "*.ts" }),
      ctx,
    );

    expect(result.content).toContain("hello.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("returns error for nonexistent directory", async () => {
    const result = await listDirectoryTool.execute(
      listDirectoryTool.parameters.parse({ path: join(testDir, "nope") }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });

  it("handles empty directory", async () => {
    const emptyDir = join(testDir, "empty");
    mkdirSync(emptyDir);

    const result = await listDirectoryTool.execute(
      listDirectoryTool.parameters.parse({ path: emptyDir }),
      ctx,
    );

    expect(result.content).toContain("empty");
  });
});

// ---------------------------------------------------------------------------
// create_directory
// ---------------------------------------------------------------------------

describe("create_directory", () => {
  it("creates a new directory", async () => {
    const dir = join(testDir, "newdir");

    const result = await createDirectoryTool.execute(
      createDirectoryTool.parameters.parse({ path: dir }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Created");
    expect(existsSync(dir)).toBe(true);
  });

  it("creates nested directories recursively", async () => {
    const dir = join(testDir, "a", "b", "c");

    const result = await createDirectoryTool.execute(
      createDirectoryTool.parameters.parse({ path: dir }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });

  it("reports if directory already exists (not an error)", async () => {
    const dir = join(testDir, "exists");
    mkdirSync(dir);

    const result = await createDirectoryTool.execute(
      createDirectoryTool.parameters.parse({ path: dir }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("already exists");
  });
});

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

describe("delete_file", () => {
  it("returns confirmation prompt when require_confirmation is true", async () => {
    const file = join(testDir, "delete-me.txt");
    writeFileSync(file, "temp");

    const result = await deleteFileTool.execute(
      deleteFileTool.parameters.parse({ path: file }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Are you sure");
    expect(existsSync(file)).toBe(true); // not deleted yet
  });

  it("deletes the file when confirmation is false", async () => {
    const file = join(testDir, "delete-me.txt");
    writeFileSync(file, "temp");

    const result = await deleteFileTool.execute(
      deleteFileTool.parameters.parse({ path: file, require_confirmation: false }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Deleted");
    expect(existsSync(file)).toBe(false);
  });

  it("returns error for nonexistent file", async () => {
    const result = await deleteFileTool.execute(
      deleteFileTool.parameters.parse({
        path: join(testDir, "nope.txt"),
        require_confirmation: false,
      }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// move_file
// ---------------------------------------------------------------------------

describe("move_file", () => {
  it("moves a file to a new location", async () => {
    const src = join(testDir, "source.txt");
    const dest = join(testDir, "dest.txt");
    writeFileSync(src, "content");

    const result = await moveFileTool.execute(
      moveFileTool.parameters.parse({ source: src, destination: dest }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("Moved");
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(dest, "utf-8")).toBe("content");
  });

  it("refuses to overwrite by default", async () => {
    const src = join(testDir, "a.txt");
    const dest = join(testDir, "b.txt");
    writeFileSync(src, "a");
    writeFileSync(dest, "b");

    const result = await moveFileTool.execute(
      moveFileTool.parameters.parse({ source: src, destination: dest }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("already exists");
  });

  it("overwrites when overwrite is true", async () => {
    const src = join(testDir, "a.txt");
    const dest = join(testDir, "b.txt");
    writeFileSync(src, "new");
    writeFileSync(dest, "old");

    const result = await moveFileTool.execute(
      moveFileTool.parameters.parse({ source: src, destination: dest, overwrite: true }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(readFileSync(dest, "utf-8")).toBe("new");
  });

  it("returns error for nonexistent source", async () => {
    const result = await moveFileTool.execute(
      moveFileTool.parameters.parse({
        source: join(testDir, "nope.txt"),
        destination: join(testDir, "dest.txt"),
      }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});

// ---------------------------------------------------------------------------
// search_files
// ---------------------------------------------------------------------------

describe("search_files", () => {
  it("finds matching lines in files", async () => {
    writeFileSync(join(testDir, "a.ts"), "const x = 1;\nconst y = 2;\n");
    writeFileSync(join(testDir, "b.ts"), "const z = 3;\n");

    const result = await searchFilesTool.execute(
      searchFilesTool.parameters.parse({ directory: testDir, pattern: "const y" }),
      ctx,
    );

    expect(result.is_error).toBeUndefined();
    expect(result.content).toContain("a.ts");
    expect(result.content).toContain("const y");
    expect(result.content).toContain("2:"); // line number
  });

  it("filters by file pattern", async () => {
    writeFileSync(join(testDir, "code.ts"), "hello\n");
    writeFileSync(join(testDir, "readme.md"), "hello\n");

    const result = await searchFilesTool.execute(
      searchFilesTool.parameters.parse({
        directory: testDir,
        pattern: "hello",
        file_pattern: "*.ts",
      }),
      ctx,
    );

    expect(result.content).toContain("code.ts");
    expect(result.content).not.toContain("readme.md");
  });

  it("case-insensitive by default", async () => {
    writeFileSync(join(testDir, "test.txt"), "Hello World\n");

    const result = await searchFilesTool.execute(
      searchFilesTool.parameters.parse({
        directory: testDir,
        pattern: "hello world",
      }),
      ctx,
    );

    expect(result.content).toContain("Hello World");
  });

  it("respects case_sensitive flag", async () => {
    writeFileSync(join(testDir, "test.txt"), "Hello World\n");

    const result = await searchFilesTool.execute(
      searchFilesTool.parameters.parse({
        directory: testDir,
        pattern: "hello world",
        case_sensitive: true,
      }),
      ctx,
    );

    expect(result.content).toContain("No matches");
  });

  it("returns error for nonexistent directory", async () => {
    const result = await searchFilesTool.execute(
      searchFilesTool.parameters.parse({
        directory: join(testDir, "nope"),
        pattern: "test",
      }),
      ctx,
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not found");
  });
});
