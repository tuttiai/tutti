import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";

const parameters = z.object({
  path: z.string().describe("Absolute or relative file path"),
  encoding: z
    .enum(["utf-8", "base64"])
    .default("utf-8")
    .describe("File encoding"),
});

export const readFileTool: Tool<z.infer<typeof parameters>> = {
  name: "read_file",
  description: "Read the contents of a file",
  parameters,
  execute: async (input) => {
    const filePath = resolve(input.path);
    try {
      const content = await readFile(filePath, input.encoding);
      return { content };
    } catch (error) {
      return { content: fsErrorMessage(error, filePath), is_error: true };
    }
  },
};
