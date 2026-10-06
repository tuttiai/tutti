import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";
import { changeSetProblem, MAX_COMMIT_ENTRIES } from "../utils/repo-paths.js";
import { branchHead, commitOnto, defaultBranchRefusal } from "../utils/branch-commit.js";
import type { CommitOutcome, CommitStep, TreeEntry } from "../utils/branch-commit.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  branch: z
    .string()
    .min(1)
    .describe("Existing branch to commit onto. Must not be the default branch; create one with create_branch."),
  message: z.string().min(1).describe("Commit message"),
  files: z
    .array(
      z.object({
        path: z.string().describe("Path relative to the repository root, e.g. 'src/index.ts'"),
        content: z.string().describe("Full new content of the file as UTF-8 text, at most 1 MB"),
      }),
    )
    .max(MAX_COMMIT_ENTRIES)
    .default([])
    .describe(
      "Files to create or overwrite, each with its full new content (UTF-8 text, at most 1 MB each). " +
        `At most ${MAX_COMMIT_ENTRIES} files and deletions together.`,
    ),
  deletions: z
    .array(z.string())
    .max(MAX_COMMIT_ENTRIES)
    .default([])
    .describe("Paths to delete, relative to the repository root. Counts towards the same limit as files."),
});

type Input = z.infer<typeof parameters>;

function describeFailure(error: unknown, input: Input, step: CommitStep): string {
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  if (step === "ref" && status === 404) {
    return (
      `[404] Branch "${input.branch}" not found in ${where}.\n` +
      `Call create_branch to create it, then commit_files onto it.`
    );
  }
  if (step === "update" && status === 422) {
    return (
      `[422] Branch "${input.branch}" moved while the commit was being written, so it was not updated ` +
      `(the branch is never force-updated).\nRetry commit_files: it builds on the branch's new head.`
    );
  }
  return ghErrorMessage(error, where);
}

function treeEntries(input: Input): TreeEntry[] {
  return [
    ...input.files.map((f) => ({ path: f.path, mode: "100644" as const, type: "blob" as const, content: f.content })),
    ...input.deletions.map((path) => ({ path, mode: "100644" as const, type: "blob" as const, sha: null })),
  ];
}

async function writeCommit(octokit: Octokit, input: Input, track: (step: CommitStep) => void): Promise<CommitOutcome> {
  const base = await branchHead(octokit, input, track);
  return commitOnto(octokit, { ...input, base, entries: treeEntries(input) }, track);
}

function summarise(input: Input, outcome: CommitOutcome): string {
  return [
    `Committed to branch ${input.branch} in ${input.owner}/${input.repo}`,
    `Commit: ${outcome.sha}`,
    `Files changed: ${input.files.length}  Deleted: ${input.deletions.length}`,
    `URL: ${outcome.url}`,
  ].join("\n");
}

/**
 * Build the `commit_files` tool.
 *
 * Writes one commit onto an existing branch through the Git Data API, with no
 * git binary or shell: the files' full new content and any deletions become a
 * tree on top of the branch head, then a commit, then a fast-forward of the
 * branch. The branch is never force-updated, so a branch that moved meanwhile
 * is left alone and the tool reports it.
 *
 * Every path is validated before any request is made: absolute paths, `..`,
 * backslashes, empty segments, anything inside `.git`, duplicates, more than
 * {@link MAX_COMMIT_ENTRIES} entries and content over 1 MB are all refused.
 *
 * **It refuses to commit to the repository's default branch.** This is a
 * deliberate safety property: an agent's changes always land on a branch of
 * their own and reach the default branch only through a reviewed pull
 * request. Create the branch with `create_branch` first.
 *
 * Marked `destructive` so it gates on human approval by default, like every
 * other tool that creates outward-facing state.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createCommitFilesTool(octokit: Octokit): Tool<Input> {
  return {
    name: "commit_files",
    description:
      "Commit file changes (full new UTF-8 content) and deletions onto an existing branch in one commit. " +
      "Refuses the default branch: call create_branch first, then create_pull_request.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const problem = changeSetProblem(input.files, input.deletions);
      if (problem !== null) return { content: problem, is_error: true };
      let step: CommitStep = "repo";
      try {
        const { data: repo } = await octokit.repos.get({ owner: input.owner, repo: input.repo });
        if (input.branch === repo.default_branch) {
          return { content: defaultBranchRefusal(input), is_error: true };
        }
        const outcome = await writeCommit(octokit, input, (next) => (step = next));
        return { content: summarise(input, outcome) };
      } catch (error) {
        return { content: describeFailure(error, input, step), is_error: true };
      }
    },
  };
}
