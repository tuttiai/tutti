import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { dataOf, str } from "../utils/format.js";

const parameters = z.object({
  title: z.string().min(1).describe("Internal campaign name, shown in reports"),
  subject: z.string().min(1).describe("Email subject line"),
  from: z.string().min(1).describe("Sender name shown to recipients"),
  reply_to: z.string().email().describe("Reply-to address; must belong to a verified domain in the account"),
  content: z.string().min(1).describe("Email body as HTML"),
  groups: z.array(z.string().min(1)).optional().describe("Group ids the campaign will target when sent"),
});

export function createCreateCampaignTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_campaign",
    description:
      "Create a DRAFT email campaign from HTML. This NEVER sends anything: the campaign stays a draft until send_campaign or schedule_campaign is called on it.",
    parameters,
    execute: (input) =>
      withClient(client, "create_campaign", async (api) => {
        const res = await api.request({
          method: "POST",
          path: "/campaigns",
          body: { ...input, content_type: "html" },
        });
        if (!res.ok) return { content: res.message, is_error: true };
        const c = dataOf(res.data);
        return {
          content: `Created draft campaign ${str(c, "id")} (status ${str(c, "status") || "DRAFT"}). Nothing has been sent.`,
        };
      }),
  };
}
