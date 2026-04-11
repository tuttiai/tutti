import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { formatNumber, truncate, ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Username or org name"),
  type: z.enum(["all", "public", "private"]).default("public").describe("Repo type filter"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
});

export function createListRepositoriesTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_repositories",
    description: "List repositories for a user or organization",
    parameters,
    execute: async (input) => {
      try {
        // Try as org first, fall back to user
        let repos;
        try {
          const { data } = await octokit.repos.listForOrg({
            org: input.owner,
            type: input.type === "private" ? "private" : input.type === "all" ? "all" : "public",
            per_page: input.limit,
            sort: "updated",
          });
          repos = data;
        } catch {
          const { data } = await octokit.repos.listForUser({
            username: input.owner,
            type: input.type === "private" ? "owner" : input.type === "all" ? "all" : "owner",
            per_page: input.limit ?? 20,
            sort: "updated",
          });
          repos = data;
        }

        if (repos.length === 0) {
          return { content: `No ${input.type} repositories found for ${input.owner}` };
        }

        const lines = repos.map((r) => {
          const desc = r.description ? `  ${truncate(r.description, 50)}` : "";
          const lang = r.language ?? "";
          const stars = formatNumber(r.stargazers_count ?? 0);
          return `  ${r.name}  ★${stars}  ${lang}${desc}`;
        });

        return {
          content: `${input.owner} — repositories:\n${lines.join("\n")}`,
        };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
