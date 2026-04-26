import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeBalanceTransactionLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, formatTime, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  type: z
    .string()
    .optional()
    .describe("Filter by transaction type (e.g. 'charge', 'refund', 'payout', 'transfer')"),
  starting_after: z.string().optional(),
});

function formatLine(t: StripeBalanceTransactionLike): string {
  const desc = t.description ? ` · ${t.description}` : "";
  return `${t.id} · ${t.type} · ${formatAmount(t.amount, t.currency)} (fee ${formatAmount(t.fee, t.currency)}, net ${formatAmount(t.net, t.currency)}) [${t.status}] · ${formatTime(t.created)}${desc}`;
}

export function createListBalanceTransactionsTool(
  client: StripeClient,
): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_balance_transactions",
    description:
      "List Stripe balance transactions — every entry that moves money in or out of the account (charges, refunds, payouts, fees, etc.).",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; type?: string; starting_after?: string } = { limit: input.limit };
        if (input.type) params.type = input.type;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.balanceTransactions.list(params);
        if (res.data.length === 0) return { content: "No balance transactions found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "balance transaction")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_balance_transactions"), is_error: true };
      }
    },
  };
}
