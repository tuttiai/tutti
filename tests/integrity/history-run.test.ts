import { describe, expect, it } from "vitest";
import { runHistory } from "../../scripts/integrity/history-run.js";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE } from "../../scripts/integrity/run.js";
import { captureWriter } from "./fake-fs.js";
import { combinedDiff, diffKey, fakeGit, mergesKey, namesKey, noPulls, preamble, sha } from "./fake-git.js";
import type { GitScript } from "./fake-git.js";

const HEAD = sha("f");
const M1 = sha("1");
const M2 = sha("2");
// Assembled at run time, with an ESC in it, so a leak is unmistakable and could not redraw a terminal.
const SENTINEL = ["SENTINEL", "7f3a", "\u001b[2J", "leak"].join("-");

async function runOn(
  script: GitScript,
  argv: readonly string[] = [],
): Promise<{ code: number; out: string[]; err: string[] }> {
  const { write, out, err } = captureWriter();
  const code = await runHistory({ git: fakeGit(script).git, argv, write });
  return { code, out, err };
}

function leaked(result: { out: string[]; err: string[] }): boolean {
  return [...result.out, ...result.err].some((line) => line.includes("SENTINEL") || line.includes("\u001b"));
}

const CLEAN: GitScript = {
  ...preamble(HEAD),
  ...noPulls(HEAD),
  [mergesKey(HEAD)]: `${M1}\n`,
  [namesKey(M1)]: "eslint.config.js\0",
  [diffKey(M1, "eslint.config.js")]: combinedDiff("eslint.config.js", ["  a", " +b"]),
};

describe("runHistory", () => {
  it("exits 0 with one line on stdout when the history is clean", async () => {
    expect(await runOn(CLEAN)).toEqual({
      code: EXIT_CLEAN,
      out: ["check:history: OK, 1 merges scanned, 0 pull requests checked, no findings"],
      err: [],
    });
  });

  it("exits 1 and reports each finding by full SHA and path, sorted, then the count", async () => {
    const result = await runOn({
      ...preamble(HEAD),
      ...noPulls(HEAD),
      [mergesKey(HEAD)]: `${M2}\n${M1}\n`,
      [namesKey(M2)]: "eslint.config.js\0",
      [diffKey(M2, "eslint.config.js")]: combinedDiff("eslint.config.js", [`++${SENTINEL}`]),
      [namesKey(M1)]: "packages/web/vite.config.ts\0",
      [diffKey(M1, "packages/web/vite.config.ts")]: combinedDiff("packages/web/vite.config.ts", ["++x"]),
    });
    expect(result).toEqual({
      code: EXIT_FINDINGS,
      out: [],
      err: [
        `history (a) ${M1} packages/web/vite.config.ts`,
        `history (a) ${M2} eslint.config.js`,
        "check:history: 2 finding(s): 2 rule (a), 0 rule (b)",
      ],
    });
    expect(leaked(result)).toBe(false);
  });

  it("escapes a path holding ESC or CR", async () => {
    const path = "a\u001b]0;x\u0007\r.config.js";
    const result = await runOn({
      ...preamble(HEAD),
      ...noPulls(HEAD),
      [mergesKey(HEAD)]: `${M1}\n`,
      [namesKey(M1)]: `${path}\0`,
      [diffKey(M1, path)]: combinedDiff(path, ["++x"]),
    });
    expect(result.err[0]).toBe(`history (a) ${M1} a\\u{1b}]0;x\\u{7}\\u{d}.config.js`);
  });

  it("exits 2 on a shallow clone, which cannot be checked", async () => {
    const result = await runOn({ "rev-parse --is-shallow-repository": "true\n" });
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err).toEqual([
      "check:history: the clone is shallow, so its history cannot be checked; run git fetch --unshallow",
    ]);
  });

  it("exits 2 when --ref names no commit", async () => {
    const result = await runOn({
      "rev-parse --is-shallow-repository": "false\n",
      "rev-parse --verify --quiet --end-of-options gone^{commit}": { code: 1, stdout: "" },
    }, ["--ref=gone"]);
    expect(result).toEqual({ code: EXIT_INCOMPLETE, out: [], err: ["check:history: --ref names no commit in this clone; with no local main, pass --ref=origin/main"] });
  });

  it("exits 2 on a git error, naming the subcommand and code but nothing git printed", async () => {
    const result = await runOn({
      ...preamble(HEAD),
      [mergesKey(HEAD)]: `${M1}\n`,
      [namesKey(M1)]: "eslint.config.js\0",
      [diffKey(M1, "eslint.config.js")]: { code: 128, stdout: combinedDiff("eslint.config.js", [`++${SENTINEL}`]) },
    });
    expect(result).toEqual({ code: EXIT_INCOMPLETE, out: [], err: ["check:history: git diff-tree exited 128"] });
    expect(leaked(result)).toBe(false);
  });

  it("exits 2 with the usage line on a bad --since, an impossible date and an unknown flag, running no git", async () => {
    for (const argv of [["--since=01-10-2026"], ["--since=2026-02-30"], ["--all"], ["--ref=-p"]]) {
      const result = await runOn({}, argv);
      expect(result.code).toBe(EXIT_INCOMPLETE);
      expect(result.err[1]).toBe("usage: npm run check:history [-- --since=YYYY-MM-DD] [--ref=<ref>]");
    }
  });

  it("lets an error that is not a git error through to the entry", async () => {
    await expect(runOn({})).rejects.toThrow("fakeGit: no answer for: rev-parse --is-shallow-repository");
  });
});
