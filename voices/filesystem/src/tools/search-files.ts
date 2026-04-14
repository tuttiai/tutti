import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { glob } from "glob";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";
import { PathSanitizer } from "../utils/sanitize.js";

const parameters = z.object({
  directory: z.string().describe("Directory to search in"),
  pattern: z.string().describe("Text to search for"),
  file_pattern: z
    .string()
    .optional()
    .describe('Glob to filter files e.g. "*.ts"'),
  case_sensitive: z
    .boolean()
    .default(false)
    .describe("Case-sensitive search"),
});

async function collectFiles(dir: string, filePattern?: string): Promise<string[]> {
  if (filePattern) {
    const matches = await glob(filePattern, { cwd: dir, nodir: true });
    return matches.map((m) => join(dir, m));
  }
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      files.push(join(entry.parentPath ?? dir, entry.name));
    }
  }
  return files;
}

export const searchFilesTool: Tool<z.infer<typeof parameters>> = {
  name: "search_files",
  description: "Search for files containing a specific text pattern",
  parameters,
  execute: async (input) => {
    let dirPath: string;
    try {
      dirPath = PathSanitizer.sanitize(input.directory);
      PathSanitizer.assertSafe(dirPath);
    } catch (error) {
      return { content: fsErrorMessage(error, input.directory), is_error: true };
    }

    try {
      await stat(dirPath);
    } catch (error) {
      return { content: fsErrorMessage(error, dirPath), is_error: true };
    }

    try {
      const files = await collectFiles(dirPath, input.file_pattern);
      const flags = input.case_sensitive ? "" : "i";
      // eslint-disable-next-line security/detect-non-literal-regexp -- pattern from validated tool input
      const regex = new RegExp(input.pattern, flags);

      const results: string[] = [];
      for (const filePath of files) {
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");
          const matches: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            const line = lines.at(i);
            if (line !== undefined && regex.test(line)) {
              matches.push(`  ${i + 1}: ${line}`);
            }
          }
          if (matches.length > 0) {
            const rel = relative(dirPath, filePath);
            results.push(`${rel}\n${matches.join("\n")}`);
          }
        } catch {
          // skip binary/unreadable files
        }
      }

      if (results.length === 0) {
        return { content: `No matches for "${input.pattern}" in ${dirPath}` };
      }
      return { content: results.join("\n\n") };
    } catch (error) {
      return { content: fsErrorMessage(error, dirPath), is_error: true };
    }
  },
};
