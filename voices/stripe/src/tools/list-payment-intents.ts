import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripePaymentIntentLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Number of payment intents to return"),
  customer: z.string().optional().describe("Filter to a single customer id"),
  starting_after: z.string().optional().describe("Pagination cursor"),
});

function formatLine(pi: StripePaymentIntentLike): string {
  const customer = pi.customer ? ` · cust=${pi.customer}` : "";
  const desc = pi.description ? ` · ${pi.description}` : "";
  return `${pi.id} · ${formatAmount(pi.amount, pi.currency)} [${pi.status}]${modeBadge(pi.livemode)}${customer}${desc} · created ${formatTime(pi.created)}`;
}

export function createListPaymentIntentsTool(
  client: StripeClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_payment_intents",
    description: "List Stripe payment intents (newest first). Filter by customer or paginate with starting_after.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; customer?: string; starting_after?: string } = { limit: input.limit };
        if (input.customer) params.customer = input.customer;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.paymentIntents.list(params);
        if (res.data.length === 0) return { content: "No payment intents found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "payment intent")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_payment_intents"), is_error: true };
      }
    },
  };
}
