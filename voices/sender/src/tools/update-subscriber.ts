import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";

const parameters = z.object({
  subscriber: z.string().min(1).describe("Subscriber email address or id"),
  firstname: z.string().optional().describe("New first name"),
  lastname: z.string().optional().describe("New last name"),
  groups: z.array(z.string().min(1)).optional().describe("Group ids to add the subscriber to"),
  fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe("Custom field values keyed by field name"),
  subscriber_status: z
    .enum(["ACTIVE", "UNSUBSCRIBED", "BOUNCED", "SPAM_REPORTED"])
    .optional()
    .describe("Email subscription status"),
  trigger_automation: z.boolean().optional().describe("Set false to avoid starting automations (default true)"),
});

export function createUpdateSubscriberTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "update_subscriber",
    description:
      "Update a subscriber's name, groups, custom fields or email status. Only the fields you pass change. Setting UNSUBSCRIBED stops all future campaign email to them.",
    parameters,
    execute: (input) =>
      withClient(client, "update_subscriber", async (api) => {
        const { subscriber, ...body } = input;
        const res = await api.request({
          method: "PATCH",
          path: `/subscribers/${encodeURIComponent(subscriber)}`,
          body,
        });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Updated subscriber ${subscriber}.` };
      }),
  };
}
