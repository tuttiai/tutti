import { describe, it, expect } from "vitest";
import { fitsHunk, hunkRanges, withMovedComments } from "../src/utils/review-comments.js";

describe("hunkRanges", () => {
  it("reads every hunk of a patch into the lines each side covers", () => {
    const patch = "@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n@@ -20,2 +21,6 @@ fn\n x\n+y";
    expect(hunkRanges(patch)).toEqual({ LEFT: [[1, 3], [20, 21]], RIGHT: [[1, 4], [21, 26]] });
  });

  it("reads a count GitHub leaves out as one line, and a count of 0 as no lines", () => {
    expect(hunkRanges("@@ -0,0 +1 @@\n+only")).toEqual({ LEFT: [], RIGHT: [[1, 1]] });
    expect(hunkRanges("@@ -1,2 +0,0 @@\n-a\n-b")).toEqual({ LEFT: [[1, 2]], RIGHT: [] });
  });

  it("finds nothing in a patch with no hunk header", () => {
    expect(hunkRanges("Binary files differ")).toEqual({ LEFT: [], RIGHT: [] });
  });
});

describe("fitsHunk", () => {
  const ranges = hunkRanges("@@ -10,3 +10,5 @@\n@@ -40,2 +42,2 @@");
  const at = (line: number, start_line?: number) => ({ path: "a", line, start_line, side: "RIGHT" as const, body: "b" });

  it("accepts a line or a range inside one hunk", () => {
    expect(fitsHunk(at(10), ranges)).toBe(true);
    expect(fitsHunk(at(14, 11), ranges)).toBe(true);
  });

  it("refuses a line outside every hunk, and a range across two", () => {
    expect(fitsHunk(at(15), ranges)).toBe(false);
    expect(fitsHunk(at(43, 12), ranges)).toBe(false);
  });

  it("checks the side the comment is on", () => {
    expect(fitsHunk({ ...at(14), side: "LEFT" }, ranges)).toBe(false);
  });
});

describe("withMovedComments", () => {
  it("leaves the body alone when nothing was moved", () => {
    expect(withMovedComments("Verdict", [])).toBe("Verdict");
  });

  it("appends each moved comment under its file and line", () => {
    const body = withMovedComments("Verdict", [{ path: "a.ts", line: 3, side: "RIGHT", body: "Why?" }]);
    expect(body).toBe("Verdict\n\n---\n\n**Comments not on a line this pull request changed**\n\n**`a.ts`, line 3**\n\nWhy?");
  });
});
