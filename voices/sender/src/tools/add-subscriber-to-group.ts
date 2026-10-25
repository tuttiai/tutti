import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { isRecord } from "../client.js";

const parameters = z.object({
  group_id: z.string().min(1).describe("Group id (from list_groups)"),
  email: z.string().email().describe("Email of an existing subscriber"),
  trigger_automation: z.boolean().optional().describe("Set false to avoid starting automations (default true)"),
});

export function createAddSubscriberToGroupTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "add_subscriber_to_group",
    description:
      "Add an existing subscriber to a group. Group membership can start automations unless trigger_automation is false.",
    parameters,
    execute: (input) =>
      withClient(client, "add_subscriber_to_group", async (api) => {
        const body: Record<string, unknown> = { subscribers: [input.email] };
        if (input.trigger_automation !== undefined) body["trigger_automation"] = input.trigger_automation;
        const res = await api.request({
          method: "POST",
          path: `/subscribers/groups/${encodeURIComponent(input.group_id)}`,
          body,
        });
        if (!res.ok) return { content: res.message, is_error: true };
        const msg = isRecord(res.data) && isRecord(res.data["message"]) ? res.data["message"] : {};
        const missing = msg["non_existing_subscribers"];
        if (Array.isArray(missing) && missing.length > 0) {
          return { content: `${input.email} is not a subscriber, so was not added. Use create_subscriber first.`, is_error: true };
        }
        return { content: `Added ${input.email} to group ${input.group_id}.` };
      }),
  };
}
