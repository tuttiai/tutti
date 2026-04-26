import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripePriceLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, modeBadge, pluralise, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Number of prices to return (max 100)"),
  product: z.string().optional().describe("Filter to prices belonging to this product id"),
  active: z.boolean().optional().describe("Filter to active prices"),
  starting_after: z.string().optional().describe("Pagination cursor"),
});

function formatLine(p: StripePriceLike): string {
  const status = p.active ? "active" : "archived";
  const amount = p.unit_amount != null ? formatAmount(p.unit_amount, p.currency) : `(custom ${p.currency.toUpperCase()})`;
  const recurring = p.recurring
    ? ` per ${p.recurring.interval_count > 1 ? `${p.recurring.interval_count} ${p.recurring.interval}s` : p.recurring.interval}`
    : " one-time";
  const nick = p.nickname ? ` · ${p.nickname}` : "";
  return `${p.id} · ${amount}${recurring} · product=${p.product} [${status}]${modeBadge(p.livemode)}${nick}`;
}

export function createListPricesTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_prices",
    description: "List Stripe prices. Filter by product, active flag, or paginate with starting_after.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; product?: string; active?: boolean; starting_after?: string } = {
          limit: input.limit,
        };
        if (input.product) params.product = input.product;
        if (input.active !== undefined) params.active = input.active;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.prices.list(params);
        if (res.data.length === 0) return { content: "No prices found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "price")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_prices"), is_error: true };
      }
    },
  };
}
