import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import { fsErrorMessage } from "../utils/format.js";

const parameters = z.object({
  path: z.string().describe("File path to delete"),
  require_confirmation: z
    .boolean()
    .default(true)
    .describe("Safety check — set to false to skip"),
});

export const deleteFileTool: Tool<z.infer<typeof parameters>> = {
  name: "delete_file",
  description: "Delete a file",
  parameters,
  execute: async (input) => {
    const filePath = resolve(input.path);
    try {
      if (input.require_confirmation) {
        return {
          content:
            `Are you sure you want to delete ${filePath}? ` +
            `Call delete_file again with require_confirmation: false to confirm.`,
        };
      }
      await unlink(filePath);
      return { content: `Deleted: ${filePath}` };
    } catch (error) {
      return { content: fsErrorMessage(error, filePath), is_error: true };
    }
  },
};
