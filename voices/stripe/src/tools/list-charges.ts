import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeChargeLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Number of charges to return"),
  customer: z.string().optional().describe("Filter to one customer id"),
  payment_intent: z.string().optional().describe("Filter to one payment intent id"),
  starting_after: z.string().optional().describe("Pagination cursor"),
});

function formatLine(ch: StripeChargeLike): string {
  const flags: string[] = [];
  if (ch.refunded) flags.push("refunded");
  if (!ch.paid) flags.push("unpaid");
  const flagPart = flags.length ? ` [${flags.join(", ")}]` : "";
  const refundedAmt =
    ch.amount_refunded > 0 ? ` (refunded ${formatAmount(ch.amount_refunded, ch.currency)})` : "";
  return `${ch.id} · ${formatAmount(ch.amount, ch.currency)}${refundedAmt} · ${ch.status}${flagPart}${modeBadge(ch.livemode)} · ${formatTime(ch.created)}`;
}

export function createListChargesTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_charges",
    description: "List Stripe charges (newest first). Filter by customer or payment_intent.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          limit: number;
          customer?: string;
          payment_intent?: string;
          starting_after?: string;
        } = { limit: input.limit };
        if (input.customer) params.customer = input.customer;
        if (input.payment_intent) params.payment_intent = input.payment_intent;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.charges.list(params);
        if (res.data.length === 0) return { content: "No charges found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "charge")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_charges"), is_error: true };
      }
    },
  };
}
