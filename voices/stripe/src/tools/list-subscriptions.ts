import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeSubscriptionLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  customer: z.string().optional().describe("Filter to one customer id"),
  status: z
    .enum(["active", "canceled", "past_due", "trialing", "all"])
    .optional()
    .describe("Filter by subscription status; 'all' includes every status"),
  starting_after: z.string().optional(),
});

function formatLine(s: StripeSubscriptionLike): string {
  const period = s.current_period_end
    ? ` · period_end ${formatTime(s.current_period_end)}`
    : "";
  const cancelAt = s.cancel_at_period_end ? " [cancel_at_period_end]" : "";
  return `${s.id} · cust=${s.customer} [${s.status}]${cancelAt}${modeBadge(s.livemode)}${period}`;
}

export function createListSubscriptionsTool(
  client: StripeClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_subscriptions",
    description: "List Stripe subscriptions (newest first). Filter by customer or status.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          limit: number;
          customer?: string;
          status?: "active" | "canceled" | "past_due" | "trialing" | "all";
          starting_after?: string;
        } = { limit: input.limit };
        if (input.customer) params.customer = input.customer;
        if (input.status) params.status = input.status;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.subscriptions.list(params);
        if (res.data.length === 0) return { content: "No subscriptions found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "subscription")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_subscriptions"), is_error: true };
      }
    },
  };
}
