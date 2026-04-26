import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeDisputeLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  charge: z.string().optional().describe("Filter to disputes against one charge id"),
  payment_intent: z.string().optional().describe("Filter to disputes against one payment intent id"),
  starting_after: z.string().optional(),
});

function formatLine(d: StripeDisputeLike): string {
  const target = d.charge ? `charge=${d.charge}` : d.payment_intent ? `pi=${d.payment_intent}` : "(unknown)";
  return `${d.id} · ${formatAmount(d.amount, d.currency)} · ${target} [${d.status}]${modeBadge(d.livemode)} · ${d.reason} · ${formatTime(d.created)}`;
}

export function createListDisputesTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_disputes",
    description: "List Stripe disputes (newest first). Filter by charge or payment intent.",
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
        const res = await c.disputes.list(params);
        if (res.data.length === 0) return { content: "No disputes found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "dispute")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_disputes"), is_error: true };
      }
    },
  };
}
