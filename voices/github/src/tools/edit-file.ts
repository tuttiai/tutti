import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage, httpStatus } from "../utils/format.js";
import { MAX_FILE_BYTES, repoPathProblem } from "../utils/repo-paths.js";
import { applyEdits, MAX_EDITS } from "../utils/text-edits.js";
import { readRepoFile } from "../utils/read-file.js";
import { branchHead, commitOnto, defaultBranchRefusal } from "../utils/branch-commit.js";
import type { CommitOutcome, CommitStep } from "../utils/branch-commit.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  branch: z
    .string()
    .min(1)
    .describe("Existing branch to commit onto. Must not be the default branch; create one with create_branch."),
  path: z.string().describe("Path of an existing file, relative to the repository root"),
  message: z.string().min(1).describe("Commit message"),
  edits: z
    .array(
      z.object({
        old_text: z.string().min(1).describe("Exact text to replace, which must occur exactly once in the file"),
        new_text: z.string().describe("Text to put in its place (empty to delete it)"),
      }),
    )
    .min(1)
    .max(MAX_EDITS)
    .describe(`Replacements applied in order, each to the result of the one before (at most ${MAX_EDITS})`),
});

type Input = z.infer<typeof parameters>;

/** A failure the tool explains itself, rather than one Octokit raised. Caught in `execute`, never thrown out of it. */
class Refusal extends Error {}

function describeFailure(error: unknown, input: Input, step: CommitStep): string {
  if (error instanceof Refusal) return error.message;
  const where = input.owner + "/" + input.repo;
  const status = httpStatus(error);
  if (step === "ref" && status === 404) {
    return `[404] Branch "${input.branch}" not found in ${where}.\nCall create_branch to create it, then edit_file on it.`;
  }
  if (step === "write" && status === 404) {
    return `[404] File "${input.path}" not found on branch "${input.branch}" in ${where}.\nedit_file changes an existing file; create a new one with commit_files.`;
  }
  if (step === "update" && status === 422) {
    return (
      `[422] Branch "${input.branch}" moved while the edit was being written, so it was not updated ` +
      `(the branch is never force-updated).\nRetry edit_file: it reads the file again at the branch's new head.`
    );
  }
  return ghErrorMessage(error, where);
}

async function editedText(octokit: Octokit, input: Input, head: string): Promise<string> {
  const read = await readRepoFile(octokit, { owner: input.owner, repo: input.repo, path: input.path, ref: head });
  if (read.kind !== "file") throw new Refusal(`"${input.path}" is not a file, so it cannot be edited.`);
  const outcome = applyEdits(read.text, input.edits);
  if (!outcome.ok) throw new Refusal(`Nothing was committed. ${outcome.problem}`);
  const bytes = Buffer.byteLength(outcome.text, "utf8");
  if (bytes > MAX_FILE_BYTES) {
    throw new Refusal(`The edited file would be ${bytes} bytes; a commit can carry at most ${MAX_FILE_BYTES} bytes (1 MB) per file.`);
  }
  return outcome.text;
}

async function writeEdit(octokit: Octokit, input: Input, track: (step: CommitStep) => void): Promise<CommitOutcome> {
  const base = await branchHead(octokit, input, track);
  // Read at the head SHA, not the branch name, so the edit is applied to exactly the commit it is parented on.
  const content = await editedText(octokit, input, base.head);
  const entries = [{ path: input.path, mode: "100644" as const, type: "blob" as const, content }];
  return commitOnto(octokit, { ...input, base, entries }, track);
}

/**
 * Build the `edit_file` tool.
 *
 * Changes part of one file without the caller ever holding the whole of it:
 * the tool reads the file in full at the branch head, applies exact-text
 * replacements, and commits the result onto the branch. It exists because
 * `commit_files` replaces a whole file, so an agent that had read a large
 * file only in part wrote back the part and lost the rest.
 *
 * Refuses, committing nothing, when any `old_text` is missing or occurs more
 * than once, when the path is not a plain repository path, and when the
 * branch is the default branch. The branch is fast-forwarded, never forced.
 * The file is written with mode 100644, as `commit_files` writes it.
 *
 * Marked `destructive` so it gates on human approval by default.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createEditFileTool(octokit: Octokit): Tool<Input> {
  return {
    name: "edit_file",
    description:
      "Change part of an existing file on a branch by exact-text replacement, and commit it. The whole file is " +
      "read and edited on the server, so it is safe on files too large to read at once. Each old_text must " +
      "occur exactly once. Refuses the default branch.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const pathProblem = repoPathProblem(input.path);
      if (pathProblem !== null) return { content: `Invalid path "${input.path}": ${pathProblem}.`, is_error: true };
      let step: CommitStep = "repo";
      try {
        const { data: repo } = await octokit.repos.get({ owner: input.owner, repo: input.repo });
        if (input.branch === repo.default_branch) return { content: defaultBranchRefusal(input), is_error: true };
        const outcome = await writeEdit(octokit, input, (next) => (step = next));
        const lines = [
          `Edited ${input.path} on branch ${input.branch} in ${input.owner}/${input.repo} (${input.edits.length} replacement(s))`,
          `Commit: ${outcome.sha}`,
          `URL: ${outcome.url}`,
        ];
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: describeFailure(error, input, step), is_error: true };
      }
    },
  };
}
