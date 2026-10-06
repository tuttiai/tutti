import type { Octokit } from "@octokit/rest";

/** Which request was in flight when a failure happened. */
export type CommitStep = "repo" | "ref" | "write" | "update";

/** One entry of the new tree: a file's full content, or `sha: null` to delete it. */
export interface TreeEntry {
  path: string;
  mode: "100644";
  type: "blob";
  content?: string;
  sha?: null;
}

/** The branch a commit goes onto, and what it carries. */
export interface BranchCommit {
  owner: string;
  repo: string;
  branch: string;
  message: string;
}

/** What a successful commit reports back. */
export interface CommitOutcome {
  sha: string;
  url: string;
}

/**
 * The refusal every branch-writing tool gives for the default branch, so an
 * agent's change always reaches it through a reviewed pull request.
 *
 * @param target - The repository and the branch that was named.
 * @returns The error text, with the fix.
 */
export function defaultBranchRefusal(target: Pick<BranchCommit, "owner" | "repo" | "branch">): string {
  return (
    `Refusing to commit to "${target.branch}", the default branch of ${target.owner}/${target.repo}.\n` +
    `Call create_branch to make a branch for this change, commit onto it, then open a pull request.`
  );
}

/**
 * Read a branch's head commit and the tree it points at.
 *
 * @param octokit - Authenticated Octokit client.
 * @param target - The repository and branch.
 * @param track - Told which request is about to run, so a 404 on the ref reads as a missing branch.
 * @returns The head SHA and its tree's SHA.
 */
export async function branchHead(
  octokit: Octokit,
  target: Pick<BranchCommit, "owner" | "repo" | "branch">,
  track: (step: CommitStep) => void,
): Promise<{ head: string; tree: string }> {
  const repo = { owner: target.owner, repo: target.repo };
  track("ref");
  const { data: ref } = await octokit.git.getRef({ ...repo, ref: `heads/${target.branch}` });
  track("write");
  const { data: parent } = await octokit.git.getCommit({ ...repo, commit_sha: ref.object.sha });
  return { head: ref.object.sha, tree: parent.tree.sha };
}

/**
 * Write one commit on top of a known head and fast-forward the branch to it.
 *
 * The branch is never force-updated: if it moved since `base.head` was read,
 * GitHub answers 422 and the branch is left as it is.
 *
 * @param octokit - Authenticated Octokit client.
 * @param commit - The branch, message, base head and tree, and the entries to write.
 * @param track - Told which request is about to run, for the caller's error message.
 * @returns The new commit.
 */
export async function commitOnto(
  octokit: Octokit,
  commit: BranchCommit & { base: { head: string; tree: string }; entries: TreeEntry[] },
  track: (step: CommitStep) => void,
): Promise<CommitOutcome> {
  const repo = { owner: commit.owner, repo: commit.repo };
  const { data: tree } = await octokit.git.createTree({ ...repo, base_tree: commit.base.tree, tree: commit.entries });
  const { data: created } = await octokit.git.createCommit({
    ...repo,
    message: commit.message,
    tree: tree.sha,
    parents: [commit.base.head],
  });
  track("update");
  await octokit.git.updateRef({ ...repo, ref: `heads/${commit.branch}`, sha: created.sha, force: false });
  return { sha: created.sha, url: created.html_url };
}
