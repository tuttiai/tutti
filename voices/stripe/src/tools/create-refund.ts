import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z
  .object({
    charge: z.string().optional().describe("Charge id to refund (e.g. 'ch_...'). Provide either charge or payment_intent."),
    payment_intent: z.string().optional().describe("Payment intent id to refund. Provide either charge or payment_intent."),
    amount: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Amount to refund in the smallest currency unit. Omit for a full refund."),
    reason: z
      .enum(["duplicate", "fraudulent", "requested_by_customer"])
      .optional()
      .describe("Reason code recorded on the refund"),
  })
  .refine((v) => v.charge || v.payment_intent, {
    message: "Provide either charge or payment_intent.",
  });

export function createCreateRefundTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_refund",
    description:
      "Refund a Stripe charge or payment intent — fully by default, or partially with an amount. This moves money back to the customer immediately.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          charge?: string;
          payment_intent?: string;
          amount?: number;
          reason?: "duplicate" | "fraudulent" | "requested_by_customer";
        } = {};
        if (input.charge) params.charge = input.charge;
        if (input.payment_intent) params.payment_intent = input.payment_intent;
        if (input.amount !== undefined) params.amount = input.amount;
        if (input.reason) params.reason = input.reason;
        const r = await c.refunds.create(params);
        return {
          content: `Refunded ${formatAmount(r.amount, r.currency)} (${r.id})${modeBadge(r.livemode)} → status=${r.status ?? "?"}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, "create_refund"), is_error: true };
      }
    },
  };
}
