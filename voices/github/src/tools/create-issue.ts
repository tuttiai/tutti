import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  title: z.string().describe("Issue title"),
  body: z.string().optional().describe("Issue body (markdown)"),
  labels: z.array(z.string()).optional().describe("Labels to apply"),
  assignees: z.array(z.string()).optional().describe("Usernames to assign"),
});

export function createCreateIssueTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_issue",
    description: "Create a new GitHub issue",
    parameters,
    execute: async (input) => {
      try {
        const { data: issue } = await octokit.issues.create({
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          body: input.body,
          labels: input.labels,
          assignees: input.assignees,
        });

        return {
          content: `Created issue #${issue.number}: ${issue.title}\n${issue.html_url}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
