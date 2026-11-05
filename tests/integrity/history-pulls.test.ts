import { describe, expect, it } from "vitest";
import { describeGap, mergedPullNumbers, parsePullRefs, scanPulls } from "../../scripts/integrity/history-pulls.js";
import { ancestorKey, fakeGit, pullRefsKey, pullSubjectsKey, sha } from "./fake-git.js";

const HEAD = sha("f");
const H7 = sha("7");
const H8 = sha("8");

describe("mergedPullNumbers", () => {
  it("reads the number from each GitHub merge subject, once each", () => {
    const subjects = [
      "Merge pull request #8 from tuttiai/feat/b",
      "Merge pull request #7 from tuttiai/feat/a",
      "Merge pull request #7 from tuttiai/feat/a",
    ].join("\n");
    expect(mergedPullNumbers(`${subjects}\n`)).toEqual([8, 7]);
  });

  it("ignores other merges and look-alike subjects", () => {
    const subjects = [
      "Merge remote-tracking branch 'origin/main' into feat/x",
      "Revert \"Merge pull request #5 from tuttiai/x\"",
      "Merge pull request #abc from tuttiai/x",
      "Merge pull request #6",
    ].join("\n");
    expect(mergedPullNumbers(subjects)).toEqual([]);
  });
});

describe("parsePullRefs", () => {
  it("maps each refs/pull/<n>/head to its SHA and ignores other refs", () => {
    const listing = [`refs/pull/7/head\0${H7}`, `refs/pull/7/merge\0${H8}`, `refs/heads/main\0${HEAD}`, ""].join("\n");
    expect(parsePullRefs(listing)).toEqual(new Map([[7, H7]]));
  });

  it("skips a line with no SHA and reads an empty listing as no refs", () => {
    expect(parsePullRefs("refs/pull/9/head\n")).toEqual(new Map());
    expect(parsePullRefs("")).toEqual(new Map());
  });
});

describe("scanPulls", () => {
  it("finds a merged pull request whose head is not an ancestor of the ref", async () => {
    const { git } = fakeGit({
      [pullSubjectsKey(HEAD)]: "Merge pull request #8 from o/b\nMerge pull request #7 from o/a\n",
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\nrefs/pull/8/head\0${H8}\n`,
      [ancestorKey(H8, HEAD)]: { code: 0, stdout: "" },
      [ancestorKey(H7, HEAD)]: { code: 1, stdout: "" },
    });
    await expect(scanPulls(git, HEAD)).resolves.toEqual({
      findings: [{ rule: "b", sha: H7, pr: 7 }],
      checked: 2,
      missing: 0,
      noRefs: false,
    });
  });

  it("counts a merged pull request with no ref as missing, and checks the rest", async () => {
    const { git } = fakeGit({
      [pullSubjectsKey(HEAD)]: "Merge pull request #8 from o/b\nMerge pull request #7 from o/a\n",
      [pullRefsKey()]: `refs/pull/8/head\0${H8}\n`,
      [ancestorKey(H8, HEAD)]: { code: 0, stdout: "" },
    });
    await expect(scanPulls(git, HEAD)).resolves.toEqual({ findings: [], checked: 1, missing: 1, noRefs: false });
  });

  it("says when pull requests were merged but the clone has no pull refs at all", async () => {
    const { git } = fakeGit({ [pullSubjectsKey(HEAD)]: "Merge pull request #7 from o/a\n", [pullRefsKey()]: "" });
    await expect(scanPulls(git, HEAD)).resolves.toEqual({ findings: [], checked: 0, missing: 1, noRefs: true });
  });

  it("is clean, not incomplete, when nothing was merged by pull request", async () => {
    const { git } = fakeGit({ [pullSubjectsKey(HEAD)]: "", [pullRefsKey()]: "" });
    await expect(scanPulls(git, HEAD)).resolves.toEqual({ findings: [], checked: 0, missing: 0, noRefs: false });
  });

  it("throws a GitError when merge-base fails for a reason other than not an ancestor", async () => {
    const { git } = fakeGit({
      [pullSubjectsKey(HEAD)]: "Merge pull request #7 from o/a\n",
      [pullRefsKey()]: `refs/pull/7/head\0${H7}\n`,
      [ancestorKey(H7, HEAD)]: { code: 128, stdout: "" },
    });
    await expect(scanPulls(git, HEAD)).rejects.toMatchObject({ subcommand: "merge-base", code: 128 });
  });
});

describe("describeGap", () => {
  const fetch = "git fetch origin '+refs/pull/*/head:refs/pull/*/head'";

  it("names the fetch when the clone has no pull refs at all", () => {
    expect(describeGap({ findings: [], checked: 0, missing: 3, noRefs: true })).toBe(
      `check:history: no refs/pull/*/head in this clone, so rule (b) checked nothing; run ${fetch}`,
    );
  });

  it("counts the missing heads when only some are absent", () => {
    expect(describeGap({ findings: [], checked: 4, missing: 2, noRefs: false })).toBe(
      `check:history: missing=2, merged pull requests with no refs/pull/<n>/head; run ${fetch}`,
    );
  });

  it("is null when every merged pull request was checked", () => {
    expect(describeGap({ findings: [], checked: 4, missing: 0, noRefs: false })).toBeNull();
  });
});
