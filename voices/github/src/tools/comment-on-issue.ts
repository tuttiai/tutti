import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  issue_number: z.number().int().describe("Issue or PR number"),
  body: z.string().describe("Comment body (markdown)"),
});

export function createCommentOnIssueTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "comment_on_issue",
    description: "Add a comment to a GitHub issue or pull request",
    parameters,
    execute: async (input) => {
      try {
        const { data: comment } = await octokit.issues.createComment({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
          body: input.body,
        });

        return {
          content: `Comment added to #${input.issue_number}\n${comment.html_url}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
