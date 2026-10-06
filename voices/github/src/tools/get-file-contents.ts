import { z } from "zod";
import type { Octokit } from "@octokit/rest";
import type { Tool } from "@tuttiai/types";
import { ghErrorMessage } from "../utils/format.js";
import { MAX_PAGE_CHARS, MAX_PAGE_LINES, pageHeader, pageOf } from "../utils/file-pages.js";
import { readRepoFile } from "../utils/read-file.js";

const parameters = z.object({
  owner: z.string().describe("Repo owner or org"),
  repo: z.string().describe("Repository name"),
  path: z.string().describe("File path in the repo"),
  ref: z.string().optional().describe("Branch, tag, or commit SHA"),
  offset: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("1-based line to start from. Use the 'next offset' the previous page reported to read on."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LINES)
    .optional()
    .describe(
      `Most lines to return (max ${MAX_PAGE_LINES}). A page also stops at ${MAX_PAGE_CHARS.toLocaleString("en-US")} characters.`,
    ),
});

type Input = z.infer<typeof parameters>;

/**
 * Build the `get_file_contents` tool.
 *
 * Reads a file, or lists a directory. A file comes back one page at a time,
 * opened by a line giving the lines returned, the file's total lines and
 * bytes, and whether the page is the whole file or only part, with the
 * offset to read on from. A page stops at `limit` lines or
 * {@link MAX_PAGE_CHARS} characters, whichever comes first, so it always
 * arrives whole: an unbounded read of a large file used to be cut in the
 * middle on its way to the model, and a file written back from that cut lost
 * everything after it. Files over 1 MB are read as blobs, so they are paged
 * rather than refused. Read-only.
 *
 * @param octokit - Authenticated Octokit client.
 * @returns The tool, ready to add to a voice's `tools` array.
 */
export function createGetFileContentsTool(octokit: Octokit): Tool<Input> {
  return {
    name: "get_file_contents",
    description:
      "Get a file from a GitHub repository, one page at a time (or list a directory). The first line says " +
      "which lines were returned out of how many and whether the read is PARTIAL, with the offset to read " +
      "on from. Never write a partial read back as the whole file: change it with edit_file instead.",
    parameters,
    execute: async (input) => {
      try {
        const read = await readRepoFile(octokit, input);
        if (read.kind === "directory") {
          const entries = read.entries.map((e) => `  ${e.type === "dir" ? "dir" : "file"}  ${e.name}`);
          return { content: `${input.path}/ (directory):\n${entries.join("\n")}` };
        }
        if (read.kind === "other") {
          return { content: `${input.path} is not a file (type: ${read.type})`, is_error: true };
        }
        const page = pageOf(read.text, { offset: input.offset, limit: input.limit });
        const where = `${input.path} @ ${input.ref ?? "default branch"}`;
        return { content: `${pageHeader(where, page, read.bytes)}\n${page.text}` };
      } catch (error) {
        return { content: ghErrorMessage(error, input.owner + "/" + input.repo), is_error: true };
      }
    },
  };
}
