import { z } from "zod";
import type { Tool } from "@tuttiai/types";

import type { KnowledgeClient } from "../client.js";

const parameters = z.object({}).strict();

/**
 * `list_knowledge_bases`: which bases this agent may search, and how much each holds.
 *
 * @param client - The agent's knowledge client.
 * @returns The tool.
 */
export function createListKnowledgeBasesTool(client: KnowledgeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_knowledge_bases",
    description: "List the knowledge bases you may search, with what each is about and how much it holds.",
    parameters,
    execute: async () => {
      const answer = await client.listBases();
      if (!answer.ok) return { content: answer.message, is_error: true };
      if (answer.data.bases.length === 0) {
        return { content: "No knowledge base is shared with you. Ask the person who deployed you to share one with this workspace." };
      }
      return { content: JSON.stringify(answer.data.bases) };
    },
  };
}
