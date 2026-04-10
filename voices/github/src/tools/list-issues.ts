import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { truncate, ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter"),
  labels: z.array(z.string()).optional().describe("Filter by labels"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
});

export function createListIssuesTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_issues",
    description: "List issues in a GitHub repository",
    parameters,
    execute: async (input) => {
      try {
        const { data } = await octokit.issues.listForRepo({
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          labels: input.labels?.join(","),
          per_page: input.limit,
        });

        // Filter out pull requests (GitHub API includes them in issues)
        const issues = data.filter((i) => !i.pull_request);

        if (issues.length === 0) {
          return { content: `No ${input.state} issues in ${input.owner}/${input.repo}` };
        }

        const lines = issues.map((i) => {
          const labels = i.labels
            .map((l) => (typeof l === "string" ? l : l.name))
            .filter(Boolean)
            .join(", ");
          const labelStr = labels ? ` [${labels}]` : "";
          return `  #${i.number}  ${truncate(i.title, 60)}${labelStr}  (${i.state})`;
        });

        return {
          content: `${input.owner}/${input.repo} — ${input.state} issues:\n${lines.join("\n")}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
