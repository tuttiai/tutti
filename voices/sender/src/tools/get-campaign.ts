import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { campaignLine, dataOf, str } from "../utils/format.js";

const parameters = z.object({
  campaign_id: z.string().min(1).describe("Campaign id"),
});

export function createGetCampaignTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_campaign",
    description: "Get one campaign by id, with status, sender, schedule and delivery counts.",
    parameters,
    execute: (input) =>
      withClient(client, "get_campaign", async (api) => {
        const res = await api.request({ method: "GET", path: `/campaigns/${encodeURIComponent(input.campaign_id)}` });
        if (!res.ok) return { content: res.message, is_error: true };
        const c = dataOf(res.data);
        const stats = ["recipient_count", "sent_count", "opens", "clicks", "bounces_count"]
          .map((k) => `${k}=${str(c, k) || "0"}`)
          .join(", ");
        const meta = [
          `from: ${str(c, "from")} <reply-to ${str(c, "reply_to")}>`,
          c["schedule_time"] ? `scheduled: ${str(c, "schedule_time")}` : "",
          c["sent_time"] ? `sent: ${str(c, "sent_time")}` : "",
          stats,
        ].filter(Boolean);
        return { content: `${campaignLine(c)}\n${meta.join("\n")}` };
      }),
  };
}
