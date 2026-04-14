import { describe, it, expect } from "vitest";
import { stripAnsi, truncateOutput, redactPaths, MAX_OUTPUT_BYTES } from "../src/utils/sanitize.js";

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("removes cursor movement sequences", () => {
    expect(stripAnsi("\x1b[2Ahello\x1b[K")).toBe("hello");
  });

  it("passes through plain text unchanged", () => {
    expect(stripAnsi("no codes here")).toBe("no codes here");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });
});

describe("truncateOutput", () => {
  it("returns the original text when under the limit", () => {
    const [text, truncated] = truncateOutput("short");
    expect(text).toBe("short");
    expect(truncated).toBe(false);
  });

  it("truncates text exceeding the byte limit", () => {
    const long = "x".repeat(MAX_OUTPUT_BYTES + 100);
    const [text, truncated] = truncateOutput(long);
    expect(truncated).toBe(true);
    expect(text).toContain("[…output truncated to 10 KB]");
    expect(Buffer.from(text, "utf-8").length).toBeLessThan(
      MAX_OUTPUT_BYTES + 100,
    );
  });

  it("accepts a custom byte limit and reflects it in the message", () => {
    const [text, truncated] = truncateOutput("abcdef", 3);
    expect(truncated).toBe(true);
    expect(text).toContain("[…output truncated to 3 bytes]");
  });

  it("shows KB in the truncation message for limits >= 1024", () => {
    const [text] = truncateOutput("x".repeat(3000), 2048);
    expect(text).toContain("[…output truncated to 2 KB]");
  });
});

describe("redactPaths", () => {
  it("replaces the working directory with <workdir>", () => {
    const msg = "Error in /tmp/tutti-ts-abc123/script.ts:1";
    const result = redactPaths(msg, "/tmp/tutti-ts-abc123");
    expect(result).toBe("Error in <workdir>/script.ts:1");
  });

  it("replaces multiple occurrences", () => {
    const msg = "/home/user/code: bad path /home/user/code/file.ts";
    const result = redactPaths(msg, "/home/user/code");
    expect(result).toBe("<workdir>: bad path <workdir>/file.ts");
  });

  it("returns original text when workDir is empty", () => {
    expect(redactPaths("unchanged", "")).toBe("unchanged");
  });
});
