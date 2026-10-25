import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";

const parameters = z.object({
  group_id: z.string().min(1).describe("Group id (from list_groups)"),
  email: z.string().email().describe("Email of the subscriber to remove from the group"),
  trigger_automation: z.boolean().optional().describe("Set false to avoid starting automations (default true)"),
});

export function createRemoveSubscriberFromGroupTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "remove_subscriber_from_group",
    description: "Remove a subscriber from one group. The subscriber itself is kept; use delete_subscriber to delete it.",
    parameters,
    execute: (input) =>
      withClient(client, "remove_subscriber_from_group", async (api) => {
        const body: Record<string, unknown> = { subscribers: [input.email] };
        if (input.trigger_automation !== undefined) body["trigger_automation"] = input.trigger_automation;
        const res = await api.request({
          method: "DELETE",
          path: `/subscribers/groups/${encodeURIComponent(input.group_id)}`,
          body,
        });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Removed ${input.email} from group ${input.group_id}.` };
      }),
  };
}
