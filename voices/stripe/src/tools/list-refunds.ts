import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeRefundLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  charge: z.string().optional().describe("Filter to refunds against this charge id"),
  payment_intent: z.string().optional().describe("Filter to refunds against this payment intent id"),
  starting_after: z.string().optional(),
});

function formatLine(r: StripeRefundLike): string {
  const target = r.charge ? `charge=${r.charge}` : r.payment_intent ? `pi=${r.payment_intent}` : "(unknown target)";
  const reason = r.reason ? ` · ${r.reason}` : "";
  return `${r.id} · ${formatAmount(r.amount, r.currency)} · ${target} [${r.status ?? "?"}]${modeBadge(r.livemode)}${reason} · ${formatTime(r.created)}`;
}

export function createListRefundsTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_refunds",
    description: "List Stripe refunds (newest first). Filter by charge or payment intent.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; charge?: string; payment_intent?: string; starting_after?: string } = {
          limit: input.limit,
        };
        if (input.charge) params.charge = input.charge;
        if (input.payment_intent) params.payment_intent = input.payment_intent;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.refunds.list(params);
        if (res.data.length === 0) return { content: "No refunds found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "refund")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_refunds"), is_error: true };
      }
    },
  };
}
