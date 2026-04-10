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
        const response = await octokit.issues.listForRepo({
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          labels: input.labels?.join(","),
          per_page: input.limit,
        });

        const data = response.data;
        const totalReturned = data.length;

        // Filter out pull requests (GitHub API includes them in issues)
        const issues = data.filter((i) => !i.pull_request);

        if (totalReturned === 0) {
          return {
            content: `No ${input.state} issues found in ${input.owner}/${input.repo}. The repository may have no issues, or if unauthenticated, you may be rate-limited (check GITHUB_TOKEN).`,
          };
        }

        if (issues.length === 0 && totalReturned > 0) {
          return {
            content: `${input.owner}/${input.repo} returned ${totalReturned} results but all were pull requests, not issues. The repository has no ${input.state} issues (only PRs).`,
          };
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
          content: `${input.owner}/${input.repo} — ${issues.length} ${input.state} issues (of ${totalReturned} results):\n${lines.join("\n")}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
