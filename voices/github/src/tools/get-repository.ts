import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { formatNumber, ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
});

export function createGetRepositoryTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_repository",
    description: "Get details about a GitHub repository",
    parameters,
    execute: async (input) => {
      try {
        const { data: repo } = await octokit.repos.get({
          owner: input.owner,
          repo: input.repo,
        });

        const topics = repo.topics?.join(", ") || "none";

        const lines = [
          `${repo.full_name}`,
          `Description: ${repo.description ?? "(none)"}`,
          `Stars: ${formatNumber(repo.stargazers_count)}  Forks: ${formatNumber(repo.forks_count)}`,
          `Language: ${repo.language ?? "unknown"}`,
          `Default branch: ${repo.default_branch}`,
          `Topics: ${topics}`,
          `Visibility: ${repo.visibility ?? (repo.private ? "private" : "public")}`,
          `Created: ${repo.created_at}`,
          `Updated: ${repo.updated_at}`,
          `URL: ${repo.html_url}`,
        ];

        return { content: lines.join("\n") };
      } catch (error) {
        return { content: ghErrorMessage(error), is_error: true };
      }
    },
  };
}
