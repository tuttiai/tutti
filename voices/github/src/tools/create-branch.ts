import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  branch: z.string().min(1).describe("Name of the new branch, e.g. 'feat/add-login'"),
  from: z
    .string()
    .min(1)
    .optional()
    .describe("Existing branch to start from. Defaults to the repository's default branch."),
});

type Input = z.infer<typeof parameters>;

/** Which request was in flight when a failure happened, and the base branch so far. */
interface Progress {
  step: "repo" | "base" | "create";
  base: string;
}

function describeFailure(error: unknown, input: Input, progress: Progress): string {
  const { step, base } = progress;
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  const message = error instanceof Error ? error.message : "";
  if (step === "base" && status === 404) {
    return `[404] Base branch "${base}" not found in ${where}.\nCheck the name, or omit "from" to start from the default branch.`;
  }
  if (step === "create" && status === 422 && /already exists/i.test(message)) {
    return (
      `[422] Branch "${input.branch}" already exists in ${where}.\n` +
      `Use commit_files to commit onto it, or pick a different branch name.`
    );
  }
  return ghErrorMessage(error, where);
}

/**
 * Build the `create_branch` tool.
 *
 * Creates a branch from the head of an existing one (the repository's default
 * branch unless `from` names another). It writes no commits: pair it with
 * `commit_files` to put changes on the branch, then `create_pull_request`.
 *
 * Marked `destructive` for the same reason as `create_pull_request`: it
 * creates outward-facing state, so it gates on human approval by default.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createCreateBranchTool(octokit: Octokit): Tool<Input> {
  return {
    name: "create_branch",
    description:
      "Create a new branch from the head of an existing branch (the default branch unless " +
      "'from' is given). Writes no commits; use commit_files to add changes to it.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const progress: Progress = { step: "repo", base: input.from ?? "" };
      try {
        if (input.from === undefined) {
          const { data: repo } = await octokit.repos.get({ owner: input.owner, repo: input.repo });
          progress.base = repo.default_branch;
        }
        progress.step = "base";
        const { data: ref } = await octokit.git.getRef({
          owner: input.owner,
          repo: input.repo,
          ref: `heads/${progress.base}`,
        });
        progress.step = "create";
        await octokit.git.createRef({
          owner: input.owner,
          repo: input.repo,
          ref: `refs/heads/${input.branch}`,
          sha: ref.object.sha,
        });
        const lines = [
          `Created branch ${input.branch} in ${input.owner}/${input.repo}`,
          `Base branch: ${progress.base}`,
          `Base SHA: ${ref.object.sha}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input, progress), is_error: true };
      }
    },
  };
}
