import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
});

export function createGetPullRequestTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_pull_request",
    description: "Get details of a specific pull request",
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
          `State: ${pr.state}${pr.merged ? " (merged)" : ""}`,
          `Author: ${pr.user?.login ?? "unknown"}`,
          `Branch: ${pr.head.ref} → ${pr.base.ref}`,
          `Changed files: ${pr.changed_files}`,
          `Additions: +${pr.additions}  Deletions: -${pr.deletions}`,
          `Comments: ${pr.comments}  Reviews: ${pr.review_comments}`,
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
