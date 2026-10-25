import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";

const parameters = z.object({
  campaign_id: z.string().min(1).describe("Id of the campaign to schedule"),
  schedule_time: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "Use the format YYYY-MM-DD HH:MM:SS")
    .describe("When to send, as YYYY-MM-DD HH:MM:SS (Sender does not document the timezone; it is normally the account's)"),
});

export function createScheduleCampaignTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "schedule_campaign",
    description:
      "Schedule a campaign to be sent later to its whole audience. When the time arrives it emails real people irreversibly; the schedule can only be cancelled in Sender before then.",
    parameters,
    destructive: true,
    execute: (input) =>
      withClient(client, "schedule_campaign", async (api) => {
        const res = await api.request({
          method: "POST",
          path: `/campaigns/${encodeURIComponent(input.campaign_id)}/schedule`,
          body: { schedule_time: input.schedule_time },
        });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Campaign ${input.campaign_id} scheduled for ${input.schedule_time}.` };
      }),
  };
}
