import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

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
        // Over-fetch because GitHub's issues endpoint mixes in PRs.
        // We filter those out, then slice to the requested limit.
        const fetchSize = Math.min(Math.max(input.limit * 3, 50), 100);

        const response = await octokit.issues.listForRepo({
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          labels: input.labels?.join(","),
          per_page: fetchSize,
        });

        const data = response.data;

        if (data.length === 0) {
          return {
            content: `No ${input.state} issues found in ${input.owner}/${input.repo}. The repository may have no issues, or if unauthenticated, you may be rate-limited (check GITHUB_TOKEN).`,
          };
        }

        // Filter out pull requests (GitHub API includes them in issues)
        const issues = data.filter((i) => !i.pull_request).slice(0, input.limit);

        if (issues.length === 0) {
          return {
            content: `No ${input.state} issues found (the results contained only pull requests). Try using list_pull_requests instead.`,
          };
        }

        const blocks = issues.map((i) => {
          const labels = i.labels
            .map((l) => (typeof l === "string" ? l : l.name))
            .filter(Boolean)
            .join(", ");
          const labelStr = labels ? ` | Labels: ${labels}` : "";
          return `#${i.number} — ${i.title}\nState: ${i.state}${labelStr}\nURL: ${i.html_url}`;
        });

        const header = `${input.owner}/${input.repo} — ${issues.length} ${input.state} issue${issues.length === 1 ? "" : "s"}:`;
        return { content: `${header}\n\n${blocks.join("\n\n")}` };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
