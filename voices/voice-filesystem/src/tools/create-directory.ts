import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";

const parameters = z.object({
  path: z.string().describe("Directory path to create"),
});

export const createDirectoryTool: Tool<z.infer<typeof parameters>> = {
  name: "create_directory",
  description: "Create a directory (and parent directories if needed)",
  parameters,
  execute: async (input) => {
    const dirPath = resolve(input.path);
    try {
      if (existsSync(dirPath)) {
        return { content: `Directory already exists: ${dirPath}` };
      }
      await mkdir(dirPath, { recursive: true });
      return { content: `Created directory: ${dirPath}` };
    } catch (error) {
      return { content: fsErrorMessage(error, dirPath), is_error: true };
    }
  },
};
