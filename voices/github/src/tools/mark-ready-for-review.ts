import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number of a draft pull request"),
});

type Input = z.infer<typeof parameters>;

/** GitHub's REST API cannot take a pull request out of draft; only this GraphQL mutation can. */
const MARK_READY = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

/**
 * Build the `mark_ready_for_review` tool.
 *
 * Takes a draft pull request out of draft, which notifies its reviewers.
 * A pull request that is already ready is reported as such, not as an error.
 * Uses the GraphQL API, because the REST API has no endpoint for it; the
 * client ships inside `@octokit/rest`, so no dependency is added.
 *
 * Marked `destructive` so it gates on human approval by default.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createMarkReadyForReviewTool(octokit: Octokit): Tool<Input> {
  return {
    name: "mark_ready_for_review",
    description: "Take a draft pull request out of draft so it is ready for review. Does not merge.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const { data: pr } = await octokit.pulls.get({ owner: input.owner, repo: input.repo, pull_number: input.pr_number });
        if (pr.draft !== true) {
          return { content: `Pull request #${pr.number} is already ready for review (not a draft).\nURL: ${pr.html_url}` };
        }
        await octokit.graphql(MARK_READY, { id: pr.node_id });
        return { content: `Marked pull request #${pr.number} ready for review: ${pr.title}\nURL: ${pr.html_url}` };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
