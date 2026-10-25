import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { listOf, pageSummary, str } from "../utils/format.js";

const parameters = z.object({
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
});

export function createListGroupsTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_groups",
    description: "List the subscriber groups in the Sender account, with their ids and subscriber counts.",
    parameters,
    execute: (input) =>
      withClient(client, "list_groups", async (api) => {
        const res = await api.request({ method: "GET", path: "/groups", query: { page: input.page } });
        if (!res.ok) return { content: res.message, is_error: true };
        const groups = listOf(res.data);
        if (groups.length === 0) return { content: "No groups found." };
        const lines = groups.map((g) => `${str(g, "id")} · ${str(g, "title")} · ${str(g, "recipient_count") || "0"} subscribers`);
        const summary = pageSummary(res.data);
        return { content: `${groups.length} group(s)${summary ? ` (${summary})` : ""}:\n\n${lines.join("\n")}` };
      }),
  };
}
