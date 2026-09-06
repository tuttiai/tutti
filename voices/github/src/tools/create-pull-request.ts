import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  title: z.string().describe("Pull request title"),
  head: z
    .string()
    .describe(
      "Branch the changes are on. Must already exist and carry at least one " +
        "commit not on base. Use 'owner:branch' for a cross-repository PR.",
    ),
  base: z.string().describe("Branch to merge into, e.g. 'main'"),
  body: z.string().optional().describe("Pull request description (markdown)"),
  draft: z
    .boolean()
    .optional()
    .describe("Open as a draft. Defaults to false."),
  maintainer_can_modify: z
    .boolean()
    .optional()
    .describe(
      "Allow maintainers of the base repo to push to the head branch. " +
        "Only meaningful for a cross-repository PR. Defaults to true.",
    ),
});

/**
 * Build the `create_pull_request` tool.
 *
 * Opens a pull request from an existing branch. It does not create the branch
 * and does not push commits — `head` must already exist with at least one
 * commit not on `base`, or GitHub rejects the request with a 422.
 *
 * Marked `destructive` so it gates on human approval by default, in line with
 * every other tool in the catalogue that creates outward-facing state. There
 * is deliberately no tool that merges a pull request.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createCreatePullRequestTool(
  octokit: Octokit,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_pull_request",
    description:
      "Open a pull request from an existing branch. The head branch must " +
      "already exist and have at least one commit not on the base branch. " +
      "Does not merge — merging is not available as a tool.",
    parameters,
    destructive: true,
    execute: async (input) => {
      try {
        const { data: pr } = await octokit.pulls.create({
          owner: input.owner,
          repo: input.repo,
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body,
          draft: input.draft,
          maintainer_can_modify: input.maintainer_can_modify,
        });

        const lines = [
          `Opened pull request #${pr.number}: ${pr.title}`,
          `Branch: ${pr.head.ref} → ${pr.base.ref}`,
          `Draft: ${pr.draft === true ? "yes" : "no"}`,
          `URL: ${pr.html_url}`,
        ];

        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: ghErrorMessage(error, input.owner + "/" + input.repo),
          is_error: true,
        };
      }
    },
  };
}
