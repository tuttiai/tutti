import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  path: z.string().describe("File path in the repo"),
  ref: z.string().optional().describe("Branch, tag, or commit SHA"),
});

export function createGetFileContentsTool(octokit: Octokit): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_file_contents",
    description: "Get the contents of a file from a GitHub repository",
    parameters,
    execute: async (input) => {
      try {
        const { data } = await octokit.repos.getContent({
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.ref,
        });

        if (Array.isArray(data)) {
          // It's a directory listing
          const entries = data.map(
            (e) => `  ${e.type === "dir" ? "dir" : "file"}  ${e.name}`,
          );
          return { content: `${input.path}/ (directory):\n${entries.join("\n")}` };
        }

        if (data.type !== "file" || !("content" in data)) {
          return { content: `${input.path} is not a file (type: ${data.type})`, is_error: true };
        }

        const content = Buffer.from(data.content, "base64").toString("utf-8");
        return { content };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
