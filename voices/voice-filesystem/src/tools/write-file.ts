import { writeFile, appendFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { formatBytes, fsErrorMessage } from "../utils/format.js";

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
    const filePath = resolve(input.path);
    try {
      if (input.append) {
        await appendFile(filePath, input.content, "utf-8");
      } else {
        await writeFile(filePath, input.content, "utf-8");
      }
      const info = await stat(filePath);
      const action = input.append ? "Appended to" : "Wrote";
      return {
        content: `${action} ${filePath} (${formatBytes(info.size)})`,
      };
    } catch (error) {
      return { content: fsErrorMessage(error, filePath), is_error: true };
    }
  },
};
