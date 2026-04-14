import { rename, access } from "node:fs/promises";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";
import { PathSanitizer } from "../utils/sanitize.js";

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
    try {
      const src = PathSanitizer.sanitize(input.source);
      PathSanitizer.assertSafe(src);
      const dest = PathSanitizer.sanitize(input.destination);
      PathSanitizer.assertSafe(dest);
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
      return { content: fsErrorMessage(error, input.source), is_error: true };
    }
  },
};
