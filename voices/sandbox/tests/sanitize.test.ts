import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  truncateOutput,
  redactPaths,
  MAX_OUTPUT_BYTES,
  HEAD_FRACTION,
} from "../src/utils/sanitize.js";

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
  const MARKER = /\[… (\d+) characters left out …\]/;

  it("returns the original text when under the limit", () => {
    const [text, truncated] = truncateOutput("short");
    expect(text).toBe("short");
    expect(truncated).toBe(false);
  });

  it("returns text exactly at the limit unchanged", () => {
    const exact = "y".repeat(MAX_OUTPUT_BYTES);
    expect(truncateOutput(exact)).toEqual([exact, false]);
  });

  it("keeps the start and the end of text exceeding the byte limit", () => {
    const long = "START" + "x".repeat(MAX_OUTPUT_BYTES * 3) + "END";
    const [text, truncated] = truncateOutput(long);
    expect(truncated).toBe(true);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text).toMatch(MARKER);
    expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(MAX_OUTPUT_BYTES + 100);
  });

  it("keeps about 30% from the start and 70% from the end", () => {
    const long = "a".repeat(5000) + "b".repeat(5000);
    const [text] = truncateOutput(long, 1000);
    const [head = "", tail = ""] = text.split(MARKER).filter((_, i) => i !== 1);
    expect(head.trim()).toBe("a".repeat(300));
    expect(tail.trim()).toBe("b".repeat(700));
  });

  it("reports how many characters were left out", () => {
    const long = "z".repeat(10_000);
    const [text] = truncateOutput(long, 1000);
    const match = MARKER.exec(text);
    expect(Number(match?.[1])).toBe(9000);
  });

  it("cuts on a line break when one is close to the cut", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(3, "0")}`);
    const [text] = truncateOutput(lines.join("\n"), 1000);
    const kept = text.split("\n").filter((l) => !MARKER.test(l));
    for (const line of kept) expect(line).toMatch(/^line \d{3}$/);
    expect(kept.at(-1)).toBe("line 399");
    expect(kept[0]).toBe("line 000");
  });

  it("never splits a multi-byte character", () => {
    const long = "é".repeat(3000) + "€".repeat(3000);
    const [text] = truncateOutput(long, 1001);
    expect(text).not.toContain("\uFFFD");
    expect(text).toMatch(MARKER);
  });

  it("handles a budget too small to keep any of the start", () => {
    const [text, truncated] = truncateOutput("abcdef", 3);
    expect(truncated).toBe(true);
    expect(text.endsWith("def")).toBe(true);
    expect(text).toMatch(MARKER);
  });

  it("exports the share of the budget kept from the start", () => {
    expect(HEAD_FRACTION).toBe(0.3);
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
