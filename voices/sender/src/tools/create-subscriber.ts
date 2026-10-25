import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";
import { dataOf, subscriberLine } from "../utils/format.js";

const parameters = z.object({
  email: z.string().email().describe("Subscriber email address"),
  firstname: z.string().min(1).optional().describe("First name"),
  lastname: z.string().min(1).optional().describe("Last name"),
  groups: z.array(z.string().min(1)).optional().describe("Group ids to add the subscriber to"),
  fields: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional()
    .describe('Custom field values keyed by field name, e.g. {"{$company}": "Acme"}'),
  trigger_automation: z.boolean().optional().describe("Set false to avoid starting automations (default true)"),
});

export function createCreateSubscriberTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_subscriber",
    description:
      "Add a subscriber to Sender, optionally into groups and with custom fields. This can start automations (and so send emails) unless trigger_automation is false.",
    parameters,
    execute: (input) =>
      withClient(client, "create_subscriber", async (api) => {
        const res = await api.request({ method: "POST", path: "/subscribers", body: input });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Created subscriber: ${subscriberLine(dataOf(res.data))}` };
      }),
  };
}
