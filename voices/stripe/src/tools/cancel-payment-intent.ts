import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  payment_intent_id: z.string().min(1).describe("Payment intent id to cancel"),
  cancellation_reason: z
    .enum(["duplicate", "fraudulent", "requested_by_customer", "abandoned"])
    .optional()
    .describe("Stripe-defined reason code"),
});

export function createCancelPaymentIntentTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "cancel_payment_intent",
    description:
      "Cancel a payment intent that has not been captured. Captured intents must be refunded with create_refund instead.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          cancellation_reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "abandoned";
        } = {};
        if (input.cancellation_reason) params.cancellation_reason = input.cancellation_reason;
        const pi = await c.paymentIntents.cancel(input.payment_intent_id, params);
        return { content: `Cancelled payment intent ${pi.id} → status=${pi.status}` };
      } catch (error) {
        return {
          content: stripeErrorMessage(error, `payment intent ${input.payment_intent_id}`),
          is_error: true,
        };
      }
    },
  };
}
