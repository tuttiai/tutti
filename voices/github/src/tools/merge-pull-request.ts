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
    .describe(
      "The head SHA whose checks you read. If the branch has moved since, GitHub refuses rather than merging " +
        "commits nobody checked.",
    ),
  merge_method: z
    .enum(["merge", "squash", "rebase"])
    .default("merge")
    .describe("How to merge: a merge commit (default), one squashed commit, or rebased commits"),
});

type Input = z.infer<typeof parameters>;

function describeFailure(error: unknown, input: Input): string {
  const where = input.owner + "/" + input.repo;
  const detail = error instanceof Error ? error.message : "refused";
  if (httpStatus(error) === 409) {
    return (
      `[409] GitHub did not merge PR #${input.pr_number} in ${where}: its head is no longer ` +
      `${input.expected_head_sha}.\nRead the new head with get_pull_request and check its CI before merging.`
    );
  }
  if (httpStatus(error) === 405) {
    return (
      `[405] GitHub did not merge PR #${input.pr_number} in ${where}: ${detail}.\n` +
      `It refuses a draft, a pull request with conflicts, one the repository's rules block, and a merge ` +
      `method the repository does not allow.`
    );
  }
  return ghErrorMessage(error, where);
}

/**
 * Build the `merge_pull_request` tool.
 *
 * Merges a pull request into its base, on GitHub, but only at the head SHA
 * the caller checked: if the branch moved, GitHub refuses with a 409. It does
 * not read CI or reviews itself; deciding a pull request is ready is the
 * caller's job.
 *
 * Marked `destructive` so it gates on human approval by default: it changes
 * the base branch, which is often what ships.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createMergePullRequestTool(octokit: Octokit): Tool<Input> {
  return {
    name: "merge_pull_request",
    description:
      "Merge a pull request into its base at the head SHA you checked. Refused when the head moved, when " +
      "it conflicts, when it is a draft, or when the repository's rules block it.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const { data } = await octokit.pulls.merge({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
          sha: input.expected_head_sha,
          merge_method: input.merge_method,
        });
        const lines = [
          `Merged pull request #${input.pr_number} in ${input.owner}/${input.repo} (${input.merge_method}).`,
          `Merge commit: ${data.sha}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input), is_error: true };
      }
    },
  };
}
