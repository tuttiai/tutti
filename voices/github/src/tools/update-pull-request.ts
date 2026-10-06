import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  pr_number: z.number().int().describe("Pull request number"),
  title: z.string().min(1).optional().describe("New title. Omit to keep the current one."),
  body: z.string().optional().describe("New description (markdown), replacing the current one. Omit to keep it."),
});

type Input = z.infer<typeof parameters>;

/**
 * Build the `update_pull_request` tool.
 *
 * Changes a pull request's title, its description, or both. The description
 * is replaced, not appended to, so read it with `get_pull_request` first
 * when only part of it should change. It changes nothing else: not the
 * branches, not the draft state (see `mark_ready_for_review`), not the state.
 *
 * Marked `destructive` so it gates on human approval by default: it rewrites
 * text everyone who can see the repository reads.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createUpdatePullRequestTool(octokit: Octokit): Tool<Input> {
  return {
    name: "update_pull_request",
    description:
      "Change a pull request's title and/or description. The description given replaces the whole " +
      "current one. Does not change branches, draft state or merge anything.",
    parameters,
    destructive: true,
    execute: async (input) => {
      if (input.title === undefined && input.body === undefined) {
        return { content: "Nothing to change: pass a title, a body, or both.", is_error: true };
      }
      try {
        const { data: pr } = await octokit.pulls.update({
          owner: input.owner,
          repo: input.repo,
          pull_number: input.pr_number,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        const changed = [input.title === undefined ? "" : "title", input.body === undefined ? "" : "description"];
        const lines = [
          `Updated pull request #${pr.number}: ${changed.filter((c) => c !== "").join(" and ")}`,
          `Title: ${pr.title}`,
          `URL: ${pr.html_url}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
