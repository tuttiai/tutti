import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
  event: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .describe("APPROVE, REQUEST_CHANGES, or COMMENT (a review that neither approves nor blocks)"),
  body: z.string().min(1).describe("The review's text (markdown): the findings, each with the file and what to do"),
  commit_id: z
    .string()
    .min(1)
    .optional()
    .describe("The head SHA you reviewed. Pins the review to it; defaults to the current head."),
});

type Input = z.infer<typeof parameters>;

function describeFailure(error: unknown, input: Input): string {
  const where = input.owner + "/" + input.repo;
  const message = error instanceof Error ? error.message : "";
  if (httpStatus(error) === 422 && /own pull request/i.test(message)) {
    return (
      `[422] GitHub does not let an account ${input.event === "APPROVE" ? "approve" : "request changes on"} its own ` +
      `pull request, and #${input.pr_number} in ${where} was opened by the connection's account.\n` +
      `Post the review with event COMMENT and state the verdict in its body.`
    );
  }
  return ghErrorMessage(error, where);
}

/**
 * Build the `create_review` tool.
 *
 * Submits a pull request review: an approval, a request for changes, or a
 * comment, with a body. It posts one review at once and leaves no pending
 * draft behind. An approval counts towards the repository's required reviews
 * wherever the connection's account is not the author, which is why it gates
 * on approval; GitHub itself refuses an account approving its own pull request.
 *
 * Marked `destructive` so it gates on human approval by default.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createCreateReviewTool(octokit: Octokit): Tool<Input> {
  return {
    name: "create_review",
    description:
      "Submit a review on a pull request: APPROVE, REQUEST_CHANGES or COMMENT, with a body. An approval counts " +
      "towards required reviews. Does not merge.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const { data: review } = await octokit.pulls.createReview({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
          event: input.event,
          body: input.body,
          ...(input.commit_id === undefined ? {} : { commit_id: input.commit_id }),
        });
        const lines = [
          `Submitted a ${review.state.toLowerCase().replace(/_/g, " ")} review on pull request #${input.pr_number}`,
          `Commit: ${review.commit_id ?? "current head"}`,
          `URL: ${review.html_url}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input), is_error: true };
      }
    },
  };
}
