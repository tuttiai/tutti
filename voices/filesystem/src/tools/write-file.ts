import { writeFile, appendFile, stat } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { formatBytes, fsErrorMessage } from "../utils/format.js";
import { PathSanitizer } from "../utils/sanitize.js";

const parameters = z.object({
  path: z.string().describe("Absolute or relative file path"),
  content: z.string().describe("Content to write"),
  append: z
    .boolean()
    .default(false)
    .describe("If true, append instead of overwrite"),
});

export const writeFileTool: Tool<z.infer<typeof parameters>> = {
  name: "write_file",
  description: "Write content to a file, creating it if it doesn't exist",
  parameters,
  execute: async (input) => {
    try {
      const filePath = PathSanitizer.sanitize(input.path);
      PathSanitizer.assertSafe(filePath);
      if (input.append) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
        await appendFile(filePath, input.content, "utf-8");
      } else {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
        await writeFile(filePath, input.content, "utf-8");
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
      const info = await stat(filePath);
      const action = input.append ? "Appended to" : "Wrote";
      return {
        content: `${action} ${filePath} (${formatBytes(info.size)})`,
      };
    } catch (error) {
      return { content: fsErrorMessage(error, input.path), is_error: true };
    }
  },
};
