import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { truncate, ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  state: z.enum(["open", "closed", "all"]).default("open").describe("PR state filter"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
});

export function createListPullRequestsTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_pull_requests",
    description: "List pull requests in a GitHub repository",
    parameters,
    execute: async (input) => {
      try {
        const { data: prs } = await octokit.pulls.list({
          owner: input.owner,
          repo: input.repo,
          state: input.state,
          per_page: input.limit,
        });

        if (prs.length === 0) {
          return { content: `No ${input.state} pull requests in ${input.owner}/${input.repo}` };
        }

        const lines = prs.map((pr) => {
          const author = pr.user?.login ?? "unknown";
          const branch = `${pr.head.ref} → ${pr.base.ref}`;
          return `  #${pr.number}  ${truncate(pr.title, 50)}  by ${author}  (${branch})`;
        });

        return {
          content: `${input.owner}/${input.repo} — ${input.state} PRs:\n${lines.join("\n")}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
