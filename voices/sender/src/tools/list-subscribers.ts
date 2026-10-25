import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { listOf, pageSummary, subscriberLine } from "../utils/format.js";

const parameters = z.object({
  group_id: z.string().min(1).optional().describe("Only list subscribers in this group (id from list_groups)"),
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
});

export function createListSubscribersTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_subscribers",
    description: "List subscribers, optionally only those in one group. Paginated with page.",
    parameters,
    execute: (input) =>
      withClient(client, "list_subscribers", async (api) => {
        const path = input.group_id ? `/groups/${encodeURIComponent(input.group_id)}/subscribers` : "/subscribers";
        const res = await api.request({ method: "GET", path, query: { page: input.page } });
        if (!res.ok) return { content: res.message, is_error: true };
        const subs = listOf(res.data);
        if (subs.length === 0) return { content: "No subscribers found." };
        const summary = pageSummary(res.data);
        return { content: `${subs.length} subscriber(s)${summary ? ` (${summary})` : ""}:\n\n${subs.map(subscriberLine).join("\n")}` };
      }),
  };
}
