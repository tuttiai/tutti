import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";
import { planComments, withMovedComments, type CommentPlan } from "../utils/review-comments.js";

const comment = z
  .object({
    path: z.string().min(1).describe("The file's path in the repository, as the diff names it"),
    line: z.number().int().min(1).describe("The line the comment sits on; with start_line, the last line of the range"),
    start_line: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("First line of a comment on several lines. Before line, in the same hunk"),
    side: z
      .enum(["RIGHT", "LEFT"])
      .default("RIGHT")
      .describe("RIGHT for the new version of the file (added and unchanged lines), LEFT for a removed line"),
    body: z.string().min(1).describe("The comment (markdown)"),
  })
  .refine((c) => c.start_line === undefined || c.start_line < c.line, {
    message: "start_line must be before line",
  });

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
  event: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .describe("APPROVE, REQUEST_CHANGES, or COMMENT (a review that neither approves nor blocks)"),
  body: z
    .string()
    .min(1)
    .describe("The review's own text (markdown): the verdict and anything that does not belong on one line"),
  commit_id: z
    .string()
    .min(1)
    .optional()
    .describe("The head SHA you reviewed. Pins the review to it; defaults to the current head."),
  comments: z
    .array(comment)
    .max(50)
    .optional()
    .describe(
      "Comments on lines of the diff, each posted on its own line. Line numbers are the file's, not the diff's. " +
        "A comment on a line the pull request did not change is moved into the body instead.",
    ),
});

type Input = z.infer<typeof parameters>;
type Review = Awaited<ReturnType<Octokit["pulls"]["createReview"]>>["data"];

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

async function post(octokit: Octokit, input: Input, plan: CommentPlan): Promise<Review> {
  const comments = plan.inline.map((c) => ({
    path: c.path,
    line: c.line,
    side: c.side,
    body: c.body,
    ...(c.start_line === undefined ? {} : { start_line: c.start_line, start_side: c.side }),
  }));
  const { data } = await octokit.pulls.createReview({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.pr_number,
    event: input.event,
    body: withMovedComments(input.body, plan.moved),
    ...(input.commit_id === undefined ? {} : { commit_id: input.commit_id }),
    ...(comments.length === 0 ? {} : { comments }),
  });
  return data;
}

// GitHub refuses the whole review over one comment it cannot place, without saying which.
// The plan already checked every line against the diff, so this only fires when the diff
// moved under it; posting every comment in the body then beats losing the review.
async function submit(octokit: Octokit, input: Input, plan: CommentPlan): Promise<[Review, CommentPlan]> {
  try {
    return [await post(octokit, input, plan), plan];
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (plan.inline.length === 0 || httpStatus(error) !== 422 || !/line|position|diff/i.test(message)) throw error;
    const fallback: CommentPlan = { inline: [], moved: [...plan.inline, ...plan.moved] };
    return [await post(octokit, input, fallback), fallback];
  }
}

/**
 * Build the `create_review` tool.
 *
 * Submits a pull request review: an approval, a request for changes, or a
 * comment, with a body and, optionally, comments on lines of the diff. It
 * posts one review at once and leaves no pending draft behind. A line comment
 * GitHub would refuse, because the pull request did not change that line, is
 * moved into the body under its file and line rather than failing the review.
 * An approval counts towards the repository's required reviews wherever the
 * connection's account is not the author, which is why it gates on approval;
 * GitHub itself refuses an account approving its own pull request.
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
      "Submit a review on a pull request: APPROVE, REQUEST_CHANGES or COMMENT, with a body and optional comments " +
      "on lines of the diff. An approval counts towards required reviews. Does not merge.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const pr = { owner: input.owner, repo: input.repo, pull_number: input.pr_number };
        const wanted = input.comments ?? [];
        const plan = wanted.length === 0 ? { inline: [], moved: [] } : await planComments(octokit, pr, wanted);
        const [review, posted] = await submit(octokit, input, plan);
        const lines = [
          `Submitted a ${review.state.toLowerCase().replace(/_/g, " ")} review on pull request #${input.pr_number}`,
          `Commit: ${review.commit_id ?? "current head"}`,
          `URL: ${review.html_url}`,
        ];
        if (wanted.length > 0) lines.push(`Line comments: ${posted.inline.length} on the diff, ${posted.moved.length} moved into the body`);
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input), is_error: true };
      }
    },
  };
}
