import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  payment_intent_id: z.string().min(1).describe("Payment intent id (e.g. 'pi_...')"),
});

export function createGetPaymentIntentTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_payment_intent",
    description: "Fetch a single Stripe payment intent by id with status, amounts, and last error.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const pi = await c.paymentIntents.retrieve(input.payment_intent_id);
        const lines = [
          `${pi.id}${modeBadge(pi.livemode)}`,
          `Status: ${pi.status}`,
          `Amount: ${formatAmount(pi.amount, pi.currency)}`,
          pi.amount_received != null ? `Received: ${formatAmount(pi.amount_received, pi.currency)}` : null,
          pi.customer ? `Customer: ${pi.customer}` : null,
          pi.description ? `Description: ${pi.description}` : null,
          pi.receipt_email ? `Receipt email: ${pi.receipt_email}` : null,
          pi.cancellation_reason ? `Cancellation: ${pi.cancellation_reason}` : null,
          pi.last_payment_error
            ? `Last error: ${pi.last_payment_error.code ?? "?"} — ${pi.last_payment_error.message ?? "(no message)"}`
            : null,
          `Created: ${formatTime(pi.created)}`,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return {
          content: stripeErrorMessage(error, `payment intent ${input.payment_intent_id}`),
          is_error: true,
        };
      }
    },
  };
}
