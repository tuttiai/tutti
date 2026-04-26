import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  subscription_id: z.string().min(1).describe("Subscription id to cancel"),
  invoice_now: z
    .boolean()
    .default(false)
    .describe("Generate a final invoice for any unbilled usage immediately"),
  prorate: z
    .boolean()
    .default(false)
    .describe("Generate a proration credit for the unused portion of the current period"),
});

export function createCancelSubscriptionTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "cancel_subscription",
    description:
      "Immediately cancel a Stripe subscription. To cancel at the end of the period, update_subscription with cancel_at_period_end=true instead (not yet exposed by this voice).",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { invoice_now?: boolean; prorate?: boolean } = {};
        if (input.invoice_now) params.invoice_now = true;
        if (input.prorate) params.prorate = true;
        const s = await c.subscriptions.cancel(input.subscription_id, params);
        return { content: `Cancelled subscription ${s.id} → status=${s.status}` };
      } catch (error) {
        return {
          content: stripeErrorMessage(error, `subscription ${input.subscription_id}`),
          is_error: true,
        };
      }
    },
  };
}
