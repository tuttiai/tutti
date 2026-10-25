import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";

const parameters = z.object({
  campaign_id: z.string().min(1).describe("Id of the campaign to send now"),
});

export function createSendCampaignTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "send_campaign",
    description:
      "Send a campaign NOW to its whole audience. This emails real people and CANNOT be undone or recalled. Check the campaign with get_campaign first.",
    parameters,
    destructive: true,
    execute: (input) =>
      withClient(client, "send_campaign", async (api) => {
        const res = await api.request({
          method: "POST",
          path: `/campaigns/${encodeURIComponent(input.campaign_id)}/send`,
        });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Campaign ${input.campaign_id} started sending.` };
      }),
  };
}
