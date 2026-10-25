import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { campaignLine, listOf, pageSummary } from "../utils/format.js";

const parameters = z.object({
  status: z.enum(["DRAFT", "SCHEDULED", "SENDING", "SENT"]).optional().describe("Only campaigns with this status"),
  limit: z.number().int().min(1).max(100).optional().describe("Campaigns per page"),
  page: z.number().int().min(1).optional().describe("Page number (default 1)"),
});

export function createListCampaignsTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_campaigns",
    description: "List email campaigns, optionally filtered by status (DRAFT, SCHEDULED, SENDING, SENT).",
    parameters,
    execute: (input) =>
      withClient(client, "list_campaigns", async (api) => {
        const res = await api.request({
          method: "GET",
          path: "/campaigns",
          query: { status: input.status, limit: input.limit, page: input.page },
        });
        if (!res.ok) return { content: res.message, is_error: true };
        const campaigns = listOf(res.data);
        if (campaigns.length === 0) return { content: "No campaigns found." };
        const summary = pageSummary(res.data);
        return { content: `${campaigns.length} campaign(s)${summary ? ` (${summary})` : ""}:\n\n${campaigns.map(campaignLine).join("\n")}` };
      }),
  };
}
