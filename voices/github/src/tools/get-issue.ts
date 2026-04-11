import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  issue_number: z.number().int().describe("Issue number"),
});

export function createGetIssueTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_issue",
    description: "Get details of a specific GitHub issue",
    parameters,
    execute: async (input) => {
      try {
        const { data: issue } = await octokit.issues.get({
          owner: input.owner,
          repo: input.repo,
          issue_number: input.issue_number,
        });

        const labels = issue.labels
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean)
          .join(", ");
        const assignees = issue.assignees?.map((a) => a.login).join(", ") ?? "none";

        const lines = [
          `#${issue.number}: ${issue.title}`,
          `State: ${issue.state}`,
          `Author: ${issue.user?.login ?? "unknown"}`,
          `Labels: ${labels || "none"}`,
          `Assignees: ${assignees}`,
          `Comments: ${issue.comments}`,
          `URL: ${issue.html_url}`,
          `Created: ${issue.created_at}`,
          "",
          issue.body ?? "(no description)",
        ];

        return { content: lines.join("\n") };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
