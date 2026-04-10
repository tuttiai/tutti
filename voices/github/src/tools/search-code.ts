import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  query: z.string().describe("Search query (supports GitHub search syntax)"),
  owner: z.string().optional().describe("Limit to a specific owner"),
  repo: z.string().optional().describe("Limit to a specific repo"),
  limit: z.number().int().min(1).max(100).default(10).describe("Max results"),
});

export function createSearchCodeTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "search_code",
    description: "Search for code across GitHub repositories",
    parameters,
    execute: async (input) => {
      try {
        let q = input.query;
        if (input.owner && input.repo) {
          q += ` repo:${input.owner}/${input.repo}`;
        } else if (input.owner) {
          q += ` user:${input.owner}`;
        }

        const { data } = await octokit.search.code({
          q,
          per_page: input.limit,
        });

        if (data.total_count === 0) {
          return { content: `No code matches for "${input.query}"` };
        }

        const lines = data.items.map((item) => {
          return `  ${item.repository.full_name}/${item.path}\n    ${item.html_url}`;
        });

        return {
          content: `${data.total_count} results (showing ${data.items.length}):\n${lines.join("\n")}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
