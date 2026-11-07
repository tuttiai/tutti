import { describe, expect, it } from "vitest";
import { runHistory } from "../../scripts/integrity/history-run.js";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE } from "../../scripts/integrity/run.js";
import { captureWriter } from "./fake-fs.js";
import {
  ancestorKey,
  combinedDiff,
  diffKey,
  fakeGit,
  mergesKey,
  namesKey,
  preamble,
  pullRefsKey,
  pullSubjectsKey,
  sha,
} from "./fake-git.js";
import type { GitScript } from "./fake-git.js";

const HEAD = sha("f");
const M1 = sha("1");
const H7 = sha("7");
const H8 = sha("8");
const FETCH = "git fetch origin '+refs/pull/*/head:refs/pull/*/head'";
// Assembled at run time, with an ESC in it, so a leak is unmistakable and could not redraw a terminal.
const SENTINEL = ["SENTINEL", "b2c1", "\u001b[2J", "leak"].join("-");
const SUBJECTS = `Merge pull request #8 from o/b\nMerge pull request #7 from o/${SENTINEL}\n`;

/** Rule (a) finds nothing: one merge, no config file in it. */
const NO_MERGE_FINDINGS: GitScript = { ...preamble(HEAD), [mergesKey(HEAD)]: `${M1}\n`, [namesKey(M1)]: "src/x.ts\0" };

async function runOn(script: GitScript): Promise<{ code: number; out: string[]; err: string[] }> {
  const { write, out, err } = captureWriter();
  const code = await runHistory({ git: fakeGit(script).git, argv: [], write });
  return { code, out, err };
}

function leaked(result: { out: string[]; err: string[] }): boolean {
  return [...result.out, ...result.err].some((line) => line.includes("SENTINEL") || line.includes("\u001b"));
}

describe("runHistory, rule (b)", () => {
  it("exits 0 with one stdout line when every merged head is on the ref", async () => {
    const result = await runOn({
      ...NO_MERGE_FINDINGS,
      [pullSubjectsKey(HEAD)]: SUBJECTS,
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\nrefs/pull/8/head\0${H8}\n`,
      [ancestorKey(H7, HEAD)]: { code: 0, stdout: "" },
      [ancestorKey(H8, HEAD)]: { code: 0, stdout: "" },
    });
    expect(result).toEqual({
      code: EXIT_CLEAN,
      out: ["check:history: OK, 1 merges scanned, 2 pull requests checked, no findings"],
      err: [],
    });
  });

  it("exits 1 on a head not on the ref, by head SHA and number, never the merge subject", async () => {
    const result = await runOn({
      ...NO_MERGE_FINDINGS,
      [pullSubjectsKey(HEAD)]: SUBJECTS,
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\nrefs/pull/8/head\0${H8}\n`,
      [ancestorKey(H7, HEAD)]: { code: 1, stdout: "" },
      [ancestorKey(H8, HEAD)]: { code: 0, stdout: "" },
    });
    expect(result).toEqual({
      code: EXIT_FINDINGS,
      out: [],
      err: [`history (b) ${H7} PR #7`, "check:history: 1 finding(s): 0 rule (a), 1 rule (b)"],
    });
    expect(leaked(result)).toBe(false);
  });

  it("lists rule (a) before rule (b) when both find something", async () => {
    const result = await runOn({
      ...preamble(HEAD),
      [mergesKey(HEAD)]: `${M1}\n`,
      [namesKey(M1)]: "eslint.config.js\0",
      [diffKey(M1, "eslint.config.js")]: combinedDiff("eslint.config.js", [`++${SENTINEL}`]),
      [pullSubjectsKey(HEAD)]: "Merge pull request #7 from o/a\n",
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\n`,
      [ancestorKey(H7, HEAD)]: { code: 1, stdout: "" },
    });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err).toEqual([
      `history (a) ${M1} eslint.config.js`,
      `history (b) ${H7} PR #7`,
      "check:history: 2 finding(s): 1 rule (a), 1 rule (b)",
    ]);
    expect(leaked(result)).toBe(false);
  });

  it("exits 2, naming the fetch, when pull requests were merged but the clone has no pull refs", async () => {
    const result = await runOn({ ...NO_MERGE_FINDINGS, [pullSubjectsKey(HEAD)]: SUBJECTS, [pullRefsKey()]: "" });
    expect(result).toEqual({
      code: EXIT_INCOMPLETE,
      out: [],
      err: [`check:history: no refs/pull/*/head in this clone, so rule (b) checked nothing; run ${FETCH}`],
    });
  });

  it("exits 2 with missing=1 when one merged pull request has no ref and nothing was found", async () => {
    const result = await runOn({
      ...NO_MERGE_FINDINGS,
      [pullSubjectsKey(HEAD)]: SUBJECTS,
      [pullRefsKey()]: `refs/pull/8/head\0${H8}\n`,
      [ancestorKey(H8, HEAD)]: { code: 0, stdout: "" },
    });
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err).toEqual([
      `check:history: missing=1, merged pull requests with no refs/pull/<n>/head; run ${FETCH}`,
    ]);
  });

  it("still exits 1 when a ref is missing but a head was found off the ref, and says both", async () => {
    const result = await runOn({
      ...NO_MERGE_FINDINGS,
      [pullSubjectsKey(HEAD)]: SUBJECTS,
      [pullRefsKey()]: `refs/pull/8/head\0${H8}\n`,
      [ancestorKey(H8, HEAD)]: { code: 1, stdout: "" },
    });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err).toEqual([
      `history (b) ${H8} PR #8`,
      `check:history: missing=1, merged pull requests with no refs/pull/<n>/head; run ${FETCH}`,
      "check:history: 1 finding(s): 0 rule (a), 1 rule (b)",
    ]);
  });

  it("exits 2 on a merge-base error, printing nothing git or the subjects held", async () => {
    const result = await runOn({
      ...NO_MERGE_FINDINGS,
      [pullSubjectsKey(HEAD)]: SUBJECTS,
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\nrefs/pull/8/head\0${H8}\n`,
      [ancestorKey(H8, HEAD)]: { code: 128, stdout: SENTINEL },
    });
    expect(result).toEqual({ code: EXIT_INCOMPLETE, out: [], err: ["check:history: git merge-base exited 128"] });
    expect(leaked(result)).toBe(false);
  });
});
