import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
  expected_head_sha: z
    .string()
    .min(1)
    .optional()
    .describe("The head SHA you last read. If the branch has moved since, GitHub refuses rather than updating."),
});

type Input = z.infer<typeof parameters>;

function describeFailure(error: unknown, input: Input): string {
  const where = input.owner + "/" + input.repo;
  if (httpStatus(error) === 422) {
    return (
      `[422] GitHub would not update the branch of PR #${input.pr_number} in ${where}: ` +
      `${error instanceof Error ? error.message : "validation failed"}.\n` +
      `It refuses when the head moved since expected_head_sha, and when the base cannot be merged in without ` +
      `conflicts; resolve those on the branch with edit_file or commit_files.`
    );
  }
  return ghErrorMessage(error, where);
}

/**
 * Build the `update_pull_request_branch` tool.
 *
 * GitHub's "Update branch" button: merges the base branch's latest commits
 * into the pull request's head branch, on GitHub, so CI runs against current
 * base. It never touches the base branch. GitHub does the merge
 * asynchronously, so the new head appears a few seconds after the call.
 *
 * Marked `destructive` so it gates on human approval by default: it adds a
 * commit to a branch.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createUpdatePullRequestBranchTool(octokit: Octokit): Tool<Input> {
  return {
    name: "update_pull_request_branch",
    description:
      "Bring a pull request's branch up to date with its base (GitHub's 'Update branch'): merges the base " +
      "into the head branch on GitHub. Refused when the merge would conflict.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const { data } = await octokit.pulls.updateBranch({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
          ...(input.expected_head_sha === undefined ? {} : { expected_head_sha: input.expected_head_sha }),
        });
        const lines = [
          `Asked GitHub to update the branch of pull request #${input.pr_number} in ${input.owner}/${input.repo}.`,
          data.message ?? "Update scheduled.",
          "The merge commit appears shortly; read the new head with get_pull_request before checking CI.",
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input), is_error: true };
      }
    },
  };
}
