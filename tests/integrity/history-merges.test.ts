import { describe, expect, it } from "vitest";
import { countNewLines, isConfigPath, scanMerges } from "../../scripts/integrity/history-merges.js";
import { combinedDiff, diffKey, fakeGit, mergesKey, namesKey, sha } from "./fake-git.js";

const HEAD = sha("f");
const M1 = sha("1");
const M2 = sha("2");

describe("isConfigPath", () => {
  it("matches a base name containing .config., at any depth", () => {
    expect(isConfigPath("eslint.config.js")).toBe(true);
    expect(isConfigPath("packages/web/vite.config.ts")).toBe(true);
    expect(isConfigPath("docs/astro.config.mjs")).toBe(true);
  });

  it("ignores .config. in a directory name and files without it", () => {
    expect(isConfigPath("x.config.d/readme.md")).toBe(false);
    expect(isConfigPath("src/config.ts")).toBe(false);
    expect(isConfigPath(".eslintrc.js")).toBe(false);
  });
});

describe("countNewLines", () => {
  it("counts ++ lines, the ones in neither parent, and not the +++ header", () => {
    const diff = combinedDiff("eslint.config.js", ["  a", " +b", "+ c", "++d", "++", "+++e", "--f", " -g"]);
    expect(countNewLines(diff)).toBe(3);
  });

  it("counts nothing when every added line comes from one parent", () => {
    expect(countNewLines(combinedDiff("eslint.config.js", ["  a", " +b", "+ c"]))).toBe(0);
  });

  it("takes the parent count from the hunk header, so an octopus merge needs +++", () => {
    const diff = ["diff --cc a.config.js", "@@@@ -1 -1 -1 +1,3 @@@@", "++ x", "+++y", " ++z", ""].join("\n");
    expect(countNewLines(diff)).toBe(1);
  });

  it("resets at the next file's header, so its +++ line is not counted", () => {
    const first = combinedDiff("a.config.js", ["  a"]);
    expect(countNewLines(`${first}diff --combined b.config.js\n+++ b/b.config.js\n`)).toBe(0);
  });

  it("counts nothing in an empty diff", () => {
    expect(countNewLines("")).toBe(0);
  });
});

describe("scanMerges", () => {
  it("finds a merge that added lines in neither parent to a config file", async () => {
    const { git } = fakeGit({
      [mergesKey(HEAD)]: `${M1}\n${M2}\n`,
      [namesKey(M1)]: "src/x.ts\0eslint.config.js\0",
      [diffKey(M1, "eslint.config.js")]: combinedDiff("eslint.config.js", ["  a", "++payload"]),
      [namesKey(M2)]: "",
    });
    await expect(scanMerges(git, { head: HEAD, since: null })).resolves.toEqual({
      findings: [{ rule: "a", sha: M1, path: "eslint.config.js" }],
      merges: 2,
    });
  });

  it("does not report ++ lines outside config files, nor a config file taken from one parent", async () => {
    const { git, calls } = fakeGit({
      [mergesKey(HEAD)]: `${M1}\n`,
      [namesKey(M1)]: "src/x.ts\0packages/web/vite.config.ts\0",
      [diffKey(M1, "packages/web/vite.config.ts")]: combinedDiff("packages/web/vite.config.ts", [" +a", "+ b"]),
    });
    await expect(scanMerges(git, { head: HEAD, since: null })).resolves.toEqual({ findings: [], merges: 1 });
    expect(calls.some((call) => call.includes("src/x.ts"))).toBe(false);
  });

  it("passes --since to rev-list as the start of that UTC day", async () => {
    const { git } = fakeGit({ [mergesKey(HEAD, "2026-10-01")]: "" });
    await expect(scanMerges(git, { head: HEAD, since: "2026-10-01" })).resolves.toEqual({ findings: [], merges: 0 });
  });

  it("asks for a path with glob characters literally", async () => {
    const path = "we*rd?.config.js";
    const { git } = fakeGit({
      [mergesKey(HEAD)]: `${M1}\n`,
      [namesKey(M1)]: `${path}\0`,
      [diffKey(M1, path)]: combinedDiff(path, ["++x"]),
    });
    const scan = await scanMerges(git, { head: HEAD, since: null });
    expect(scan.findings).toEqual([{ rule: "a", sha: M1, path }]);
  });

  it("throws a GitError when a diff call fails", async () => {
    const { git } = fakeGit({ [mergesKey(HEAD)]: `${M1}\n`, [namesKey(M1)]: { code: 128, stdout: "" } });
    await expect(scanMerges(git, { head: HEAD, since: null })).rejects.toMatchObject({ subcommand: "diff-tree" });
  });
});
