import type { GitResult, GitRunner } from "../../scripts/integrity/git.js";

/** Canned git output by the joined argument list. A string is stdout with exit code 0. */
export type GitScript = Readonly<Record<string, GitResult | string>>;

/**
 * A GitRunner that answers from a script, so tests run no git and touch no disk. An argument
 * list the script does not know rejects, and `runHistory` does not catch that, so a changed git
 * call fails the test instead of passing silently.
 */
export function fakeGit(script: GitScript): { git: GitRunner; calls: string[] } {
  const answers = new Map(Object.entries(script));
  const calls: string[] = [];
  const git: GitRunner = {
    run: (args) => {
      const key = args.join(" ");
      const answer = answers.get(key);
      if (answer === undefined) return Promise.reject(new Error(`fakeGit: no answer for: ${key}`));
      calls.push(key);
      return Promise.resolve(typeof answer === "string" ? { code: 0, stdout: answer } : answer);
    },
  };
  return { git, calls };
}

/** A full SHA made of one repeated hex digit, so fixtures read clearly. */
export function sha(digit: string): string {
  return digit.repeat(40);
}

/** The calls `runHistory` makes before any rule: not shallow, and `main` resolves to `head`. */
export function preamble(head: string): GitScript {
  return {
    "rev-parse --is-shallow-repository": "false\n",
    "rev-parse --verify --quiet --end-of-options main^{commit}": `${head}\n`,
  };
}

/** The arguments of rule (a)'s merge listing. */
export function mergesKey(head: string, since?: string): string {
  const window = since === undefined ? "" : `--since=${since}T00:00:00Z `;
  return `rev-list --merges ${window}--end-of-options ${head}`;
}

/** The arguments of rule (a)'s name listing for one merge. */
export function namesKey(merge: string): string {
  return `diff-tree --cc -r -z --name-only --no-commit-id --no-ext-diff --no-textconv --no-color --end-of-options ${merge}`;
}

/** The arguments of rule (a)'s combined diff of one file. */
export function diffKey(merge: string, path: string): string {
  const options = "--cc -p -r --no-commit-id --no-ext-diff --no-textconv --no-color";
  return `diff-tree ${options} --end-of-options ${merge} -- :(literal)${path}`;
}

/** The arguments of rule (b)'s first-parent merge subjects. */
export function pullSubjectsKey(head: string): string {
  return `log --first-parent --merges --format=%s --end-of-options ${head}`;
}

/** The arguments of rule (b)'s pull ref listing. */
export function pullRefsKey(): string {
  return "for-each-ref --format=%(refname)%00%(objectname) refs/pull/";
}

/** The arguments of rule (b)'s ancestor check of one pull request head. */
export function ancestorKey(pullHead: string, head: string): string {
  return `merge-base --is-ancestor --end-of-options ${pullHead} ${head}`;
}

/** Rule (b)'s calls when nothing was merged by pull request. */
export function noPulls(head: string): GitScript {
  return { [pullSubjectsKey(head)]: "", [pullRefsKey()]: "" };
}

/**
 * A two-parent combined diff of one file, shaped as `git diff-tree --cc -p` prints it. Each body
 * line already carries its two prefix columns.
 */
export function combinedDiff(path: string, body: readonly string[]): string {
  const header = [`diff --cc ${path}`, "index 1111111,2222222..3333333", `--- a/${path}`, `+++ b/${path}`];
  return [...header, "@@@ -1,3 -1,3 +1,4 @@@", ...body, ""].join("\n");
}
