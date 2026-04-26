import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  refund_id: z.string().min(1).describe("Refund id (e.g. 're_...')"),
});

export function createGetRefundTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_refund",
    description: "Fetch a single Stripe refund by id with amount, status, reason, and target charge/intent.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const r = await c.refunds.retrieve(input.refund_id);
        const lines = [
          `${r.id}${modeBadge(r.livemode)}`,
          `Amount: ${formatAmount(r.amount, r.currency)}`,
          `Status: ${r.status ?? "?"}`,
          r.reason ? `Reason: ${r.reason}` : null,
          r.charge ? `Charge: ${r.charge}` : null,
          r.payment_intent ? `Payment intent: ${r.payment_intent}` : null,
          `Created: ${formatTime(r.created)}`,
        ].filter((l): l is string => l !== null);
        return { content: lines.join("\n") };
      } catch (error) {
        return { content: stripeErrorMessage(error, `refund ${input.refund_id}`), is_error: true };
      }
    },
  };
}
