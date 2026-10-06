import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";

/** Upper bound on the characters returned, so a large commit is cut by the tool and says so. */
export const MAX_COMMIT_CHARS = 40_000;

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  sha: z.string().min(1).describe("Commit SHA (full or abbreviated), or a branch name for its head commit"),
});

type Input = z.infer<typeof parameters>;

/** The parts of one changed file this tool reports. */
interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string | undefined;
  previous_filename?: string | undefined;
}

function fileBlock(file: ChangedFile): string {
  const renamed = file.previous_filename === undefined ? "" : ` (from ${file.previous_filename})`;
  const head = `--- ${file.filename}${renamed}: ${file.status}, +${file.additions} -${file.deletions}`;
  const patch = file.patch ?? "(no patch: binary, or too large for the API to include)";
  return `${head}\n${patch}`;
}

function render(header: string[], files: readonly ChangedFile[]): string {
  let out = header.join("\n");
  for (const [index, file] of files.entries()) {
    const block = `\n\n${fileBlock(file)}`;
    if (out.length + block.length > MAX_COMMIT_CHARS) {
      const rest = files.slice(index).map((f) => f.filename).join(", ");
      return `${out}\n\n[Output cut at ${MAX_COMMIT_CHARS.toLocaleString("en-US")} characters. Not shown: ${rest}. Read those files with get_file_contents at this commit.]`;
    }
    out += block;
  }
  return out;
}

/**
 * Build the `get_commit` tool.
 *
 * Reads one commit: its message, author, parents and each changed file with
 * its patch, so a reviewer can see exactly what one commit of a pull request
 * did rather than only the pull request's combined diff. Output is capped at
 * {@link MAX_COMMIT_CHARS} characters and names every file it left out.
 * Read-only.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createGetCommitTool(octokit: Octokit): Tool<Input> {
  return {
    name: "get_commit",
    description: "Read one commit: its message, author, parents, and each changed file with its patch (diff).",
    parameters,
    execute: async (input) => {
      try {
        const { data: commit } = await octokit.repos.getCommit({ owner: input.owner, repo: input.repo, ref: input.sha });
        const files: ChangedFile[] = commit.files ?? [];
        const header = [
          `Commit ${commit.sha} in ${input.owner}/${input.repo}`,
          `Author: ${commit.commit.author?.name ?? commit.author?.login ?? "unknown"}  Date: ${commit.commit.author?.date ?? "unknown"}`,
          `Parents: ${commit.parents.map((p) => p.sha).join(", ") || "none"}`,
          `Files: ${files.length}  +${commit.stats?.additions ?? 0} -${commit.stats?.deletions ?? 0}`,
          `URL: ${commit.html_url}`,
          "",
          commit.commit.message,
        ];
        return { content: render(header, files) };
      } catch (error) {
        const where = input.owner + "/" + input.repo;
        if (httpStatus(error) === 422 || httpStatus(error) === 404) {
          return { content: `[${httpStatus(error)}] No commit "${input.sha}" in ${where}.\nTake the SHA from get_pull_request or list_pull_request_checks.`, is_error: true };
        }
        return { content: ghErrorMessage(error, where), is_error: true };
      }
    },
  };
}
