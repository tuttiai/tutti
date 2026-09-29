import { describe, it, expect } from "vitest";
import {
  repoPathProblem,
  changeSetProblem,
  MAX_COMMIT_ENTRIES,
  MAX_FILE_BYTES,
} from "../src/utils/repo-paths.js";

describe("repoPathProblem", () => {
  it.each(["README.md", "src/index.ts", "a/b/c.d.e", ".github/workflows/ci.yml", ".gitignore", "dir/.gitkeep"])(
    "accepts %s",
    (path) => {
      expect(repoPathProblem(path)).toBeNull();
    },
  );

  it.each([
    ["", "empty"],
    ["/etc/passwd", "absolute"],
    ["src\\index.ts", "backslashes"],
    ["../outside.txt", "'..'"],
    ["src/../../x", "'..'"],
    ["./src/index.ts", "'.'"],
    ["src//index.ts", "empty segments"],
    ["src/", "empty segments"],
    [".git/config", ".git"],
    [".git/hooks/pre-commit", ".git"],
    ["vendor/.git/config", ".git"],
    [".GIT/config", ".git"],
    ["bad\u0000name", "control characters"],
    ["tab\there", "control characters"],
  ])("refuses %j (%s)", (path, reason) => {
    expect(repoPathProblem(path)).toContain(reason);
  });
});

describe("changeSetProblem", () => {
  it("accepts a mix of files and deletions", () => {
    expect(changeSetProblem([{ path: "a.txt", content: "a" }], ["b.txt"])).toBeNull();
  });

  it("refuses an empty change set", () => {
    expect(changeSetProblem([], [])).toContain("Nothing to commit");
  });

  it("refuses more than the entry cap across files and deletions", () => {
    const files = Array.from({ length: 60 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    const deletions = Array.from({ length: MAX_COMMIT_ENTRIES - 59 }, (_, i) => `d${i}.txt`);
    expect(changeSetProblem(files, deletions)).toContain(`${MAX_COMMIT_ENTRIES + 1}`);
  });

  it("accepts exactly the entry cap", () => {
    const files = Array.from({ length: MAX_COMMIT_ENTRIES }, (_, i) => ({ path: `f${i}.txt`, content: "x" }));
    expect(changeSetProblem(files, [])).toBeNull();
  });

  it("names the invalid path", () => {
    expect(changeSetProblem([{ path: "../x", content: "" }], [])).toContain('Invalid path "../x"');
    expect(changeSetProblem([], [".git/HEAD"])).toContain('Invalid path ".git/HEAD"');
  });

  it("refuses a path listed twice in files", () => {
    const files = [
      { path: "a.txt", content: "1" },
      { path: "a.txt", content: "2" },
    ];
    expect(changeSetProblem(files, [])).toContain('Duplicate path "a.txt"');
  });

  it("refuses a path both written and deleted", () => {
    expect(changeSetProblem([{ path: "a.txt", content: "1" }], ["a.txt"])).toContain("Duplicate path");
  });

  it("refuses content over 1 MB, counted in UTF-8 bytes", () => {
    // Each "é" is two bytes, so this is just over the limit in bytes but not in characters.
    const content = "é".repeat(MAX_FILE_BYTES / 2 + 1);
    expect(changeSetProblem([{ path: "big.txt", content }], [])).toContain("1 MB");
  });

  it("accepts content of exactly 1 MB", () => {
    expect(changeSetProblem([{ path: "ok.txt", content: "a".repeat(MAX_FILE_BYTES) }], [])).toBeNull();
  });
});
