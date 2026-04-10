import { rename, access } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";

const parameters = z.object({
  source: z.string().describe("Source path"),
  destination: z.string().describe("Destination path"),
  overwrite: z
    .boolean()
    .default(false)
    .describe("Overwrite if destination exists"),
});

export const moveFileTool: Tool<z.infer<typeof parameters>> = {
  name: "move_file",
  description: "Move or rename a file or directory",
  parameters,
  execute: async (input) => {
    const src = resolve(input.source);
    const dest = resolve(input.destination);
    try {
      if (!input.overwrite) {
        try {
          await access(dest);
          return {
            content: `Destination already exists: ${dest}. Set overwrite: true to replace.`,
            is_error: true,
          };
        } catch {
          // destination doesn't exist — safe to proceed
        }
      }
      await rename(src, dest);
      return { content: `Moved ${src} → ${dest}` };
    } catch (error) {
      return { content: fsErrorMessage(error, src), is_error: true };
    }
  },
};
