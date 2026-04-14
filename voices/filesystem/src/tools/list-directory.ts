import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import { glob } from "glob";
import type { Tool } from "@tuttiai/types";
import { formatBytes, fsErrorMessage } from "../utils/format.js";
import { PathSanitizer } from "../utils/sanitize.js";

const parameters = z.object({
  path: z.string().describe("Directory path"),
  recursive: z
    .boolean()
    .default(false)
    .describe("List recursively"),
  pattern: z
    .string()
    .optional()
    .describe('Glob pattern filter e.g. "*.ts"'),
});

export const listDirectoryTool: Tool<z.infer<typeof parameters>> = {
  name: "list_directory",
  description: "List files and directories at a given path",
  parameters,
  execute: async (input) => {
    try {
      const dirPath = PathSanitizer.sanitize(input.path);
      PathSanitizer.assertSafe(dirPath);
      if (input.pattern) {
        const matches = await glob(input.pattern, {
          cwd: dirPath,
          dot: false,
          nodir: false,
        });
        if (matches.length === 0) {
          return { content: `No matches for "${input.pattern}" in ${dirPath}` };
        }
        const lines: string[] = [];
        for (const match of matches.sort()) {
          const fullPath = join(dirPath, match);
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built via join() from sanitized dir
            const info = await stat(fullPath);
            const type = info.isDirectory() ? "dir" : "file";
            const size = info.isDirectory() ? "" : ` (${formatBytes(info.size)})`;
            lines.push(`  ${type}  ${match}${size}`);
          } catch {
            lines.push(`  ???   ${match}`);
          }
        }
        return { content: `${dirPath}/\n${lines.join("\n")}` };
      }

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
      const entries = await readdir(dirPath, {
        withFileTypes: true,
        recursive: input.recursive,
      });

      if (entries.length === 0) {
        return { content: `${dirPath}/ (empty)` };
      }

      const lines: string[] = [];
      for (const entry of entries) {
        const entryPath = join(
          entry.parentPath ?? dirPath,
          entry.name,
        );
        const rel = relative(dirPath, entryPath);
        if (entry.isDirectory()) {
          lines.push(`  dir   ${rel}/`);
        } else {
          try {
            // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built via join() from sanitized dir
            const info = await stat(entryPath);
            lines.push(`  file  ${rel} (${formatBytes(info.size)})`);
          } catch {
            lines.push(`  file  ${rel}`);
          }
        }
      }

      return { content: `${dirPath}/\n${lines.join("\n")}` };
    } catch (error) {
      return { content: fsErrorMessage(error, input.path), is_error: true };
    }
  },
};
