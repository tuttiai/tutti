import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  charge_id: z.string().min(1).describe("Charge id (e.g. 'ch_...')"),
});

export function createGetChargeTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_charge",
    description: "Fetch a single Stripe charge by id with status, amounts, and failure details.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const ch = await c.charges.retrieve(input.charge_id);
        const lines = [
          `${ch.id}${modeBadge(ch.livemode)}`,
          `Status: ${ch.status}`,
          `Amount: ${formatAmount(ch.amount, ch.currency)}`,
          `Captured: ${formatAmount(ch.amount_captured, ch.currency)}`,
          `Refunded: ${formatAmount(ch.amount_refunded, ch.currency)}${ch.refunded ? " (fully)" : ""}`,
          `Paid: ${ch.paid ? "yes" : "no"}`,
          ch.customer ? `Customer: ${ch.customer}` : null,
          ch.payment_intent ? `Payment intent: ${ch.payment_intent}` : null,
          ch.description ? `Description: ${ch.description}` : null,
          ch.failure_message ? `Failure: ${ch.failure_code ?? "?"} — ${ch.failure_message}` : null,
          ch.receipt_url ? `Receipt: ${ch.receipt_url}` : null,
          `Created: ${formatTime(ch.created)}`,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: stripeErrorMessage(error, `charge ${input.charge_id}`), is_error: true };
      }
    },
  };
}
