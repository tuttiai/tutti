import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attempt, describeError, writeFileAtomic } from "../../src/state/atomic-write.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tutti-atomic-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("replaces the file and leaves no temporary file", () => {
    writeFileAtomic(join(dir, "a.json"), "one");
    writeFileAtomic(join(dir, "a.json"), "two");
    expect(readFileSync(join(dir, "a.json"), "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["a.json"]);
  });

  it("throws and cleans up when the directory is missing", () => {
    expect(() => writeFileAtomic(join(dir, "missing", "a.json"), "x")).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("attempt", () => {
  it("resolves with the work's result", async () => {
    await expect(attempt(() => 3)).resolves.toBe(3);
  });

  it("rejects with an Error whatever was thrown", async () => {
    await expect(attempt(() => { throw "plain"; })).rejects.toThrow("plain");
    expect(describeError(new Error("m"))).toBe("m");
  });
});
