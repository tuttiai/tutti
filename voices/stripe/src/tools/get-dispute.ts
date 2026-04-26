import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  dispute_id: z.string().min(1).describe("Dispute id (e.g. 'dp_...')"),
});

export function createGetDisputeTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_dispute",
    description: "Fetch a single Stripe dispute by id.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const d = await c.disputes.retrieve(input.dispute_id);
        const lines = [
          `${d.id}${modeBadge(d.livemode)}`,
          `Status: ${d.status}`,
          `Reason: ${d.reason}`,
          `Amount: ${formatAmount(d.amount, d.currency)}`,
          d.charge ? `Charge: ${d.charge}` : null,
          d.payment_intent ? `Payment intent: ${d.payment_intent}` : null,
          `Created: ${formatTime(d.created)}`,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: stripeErrorMessage(error, `dispute ${input.dispute_id}`), is_error: true };
      }
    },
  };
}
