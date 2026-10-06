import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
});

type Input = z.infer<typeof parameters>;

/** GitHub's page-size ceiling for reviews. A pull request with more shows the first hundred and says so. */
const PER_PAGE = 100;

/** The parts of one review this tool reports. */
interface ReviewSummary {
  id: number;
  state: string;
  user: { login: string } | null;
  commit_id?: string | null | undefined;
  submitted_at?: string | null | undefined;
}

function reviewLine(review: ReviewSummary): string {
  const who = review.user?.login ?? "unknown";
  const on = review.commit_id ? ` on ${review.commit_id.slice(0, 7)}` : "";
  const when = review.submitted_at ? ` at ${review.submitted_at}` : " (pending, not submitted)";
  return `  - ${review.state.toLowerCase().replace(/_/g, " ")} by ${who}${on}${when} (review ${String(review.id)})`;
}

/** The reviews section: every submitted or pending review, or why they could not be read. */
async function reviewsOf(octokit: Octokit, input: Input): Promise<string[]> {
  try {
    const { data } = await octokit.pulls.listReviews({ owner: input.owner, repo: input.repo, pull_number: input.pr_number, per_page: PER_PAGE });
    const reviews: ReviewSummary[] = data;
    const more = reviews.length === PER_PAGE ? ` (showing the first ${String(PER_PAGE)})` : "";
    if (reviews.length === 0) return ["Reviews: none"];
    return [`Reviews: ${String(reviews.length)}${more}`, ...reviews.map(reviewLine)];
  } catch (error) {
    const status = httpStatus(error);
    return [`Reviews: could not be read${status === undefined ? "" : ` [${String(status)}]`}. The pull request itself is above.`];
  }
}

/**
 * Build the `get_pull_request` tool.
 *
 * Reads one pull request: its state, branches and head commit, its size, and
 * every review with its state, author and the commit it was given on. The
 * reviews are listed rather than counted because the count GitHub puts on a
 * pull request, `review_comments`, is of inline comments, so a review with
 * only a body counted as none. A QA agent read "Reviews: 0" after a review
 * had been posted and asked the owner to check. Read-only.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createGetPullRequestTool(octokit: Octokit): Tool<Input> {
  return {
    name: "get_pull_request",
    description: "Get a pull request: state, branches, head commit, size, description, and every review with its state and author",
    parameters,
    execute: async (input) => {
      try {
        const { data: pr } = await octokit.pulls.get({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
        });

        const lines = [
          `#${pr.number}: ${pr.title}`,
          `State: ${pr.state}${pr.merged ? " (merged)" : ""}${pr.draft === true ? " (draft)" : ""}`,
          `Author: ${pr.user?.login ?? "unknown"}`,
          `Branch: ${pr.head.ref} → ${pr.base.ref}`,
          `Head: ${pr.head.sha}`,
          `Changed files: ${pr.changed_files}`,
          `Additions: +${pr.additions}  Deletions: -${pr.deletions}`,
          `Comments: ${pr.comments}  Inline review comments: ${pr.review_comments}`,
          ...(await reviewsOf(octokit, input)),
          `URL: ${pr.html_url}`,
          "",
          pr.body ?? "(no description)",
        ];

        return { content: lines.join("\n") };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
