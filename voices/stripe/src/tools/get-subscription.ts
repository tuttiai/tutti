import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatMetadata, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  subscription_id: z.string().min(1).describe("Subscription id (e.g. 'sub_...')"),
});

export function createGetSubscriptionTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_subscription",
    description: "Fetch a single Stripe subscription by id with status, period, and price items.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const s = await c.subscriptions.retrieve(input.subscription_id);
        const items = s.items?.data ?? [];
        const itemLines = items.map(
          (it) => `  - item ${it.id} · price ${it.price.id} · qty ${it.quantity ?? 1}`,
        );
        const lines = [
          `${s.id}${modeBadge(s.livemode)}`,
          `Customer: ${s.customer}`,
          `Status: ${s.status}`,
          `Cancel at period end: ${s.cancel_at_period_end ? "yes" : "no"}`,
          s.current_period_start
            ? `Current period: ${formatTime(s.current_period_start)} → ${formatTime(s.current_period_end)}`
            : null,
          s.canceled_at ? `Canceled at: ${formatTime(s.canceled_at)}` : null,
          `Created: ${formatTime(s.created)}${formatMetadata(s.metadata)}`,
          items.length > 0 ? `Items:\n${itemLines.join("\n")}` : null,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: stripeErrorMessage(error, `subscription ${input.subscription_id}`),
          is_error: true,
        };
      }
    },
  };
}
