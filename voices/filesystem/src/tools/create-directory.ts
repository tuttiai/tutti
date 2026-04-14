import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";
import { PathSanitizer } from "../utils/sanitize.js";

const parameters = z.object({
  path: z.string().describe("Directory path to create"),
});

export const createDirectoryTool: Tool<z.infer<typeof parameters>> = {
  name: "create_directory",
  description: "Create a directory (and parent directories if needed)",
  parameters,
  execute: async (input) => {
    try {
      const dirPath = PathSanitizer.sanitize(input.path);
      PathSanitizer.assertSafe(dirPath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
      if (existsSync(dirPath)) {
        return { content: `Directory already exists: ${dirPath}` };
      }
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- path sanitized via PathSanitizer
      await mkdir(dirPath, { recursive: true });
      return { content: `Created directory: ${dirPath}` };
    } catch (error) {
      return { content: fsErrorMessage(error, input.path), is_error: true };
    }
  },
};
