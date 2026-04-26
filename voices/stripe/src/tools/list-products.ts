import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient, StripeProductLike } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatTime, modeBadge, pluralise, stripeErrorMessage, truncate } from "../utils/format.js";

const parameters = z.object({
  limit: z.number().int().min(1).max(100).default(20).describe("Number of products to return (max 100)"),
  active: z.boolean().optional().describe("Filter to active=true (live) or active=false (archived)"),
  starting_after: z.string().optional().describe("Pagination cursor"),
});

function formatLine(p: StripeProductLike): string {
  const status = p.active ? "active" : "archived";
  const desc = p.description ? ` — ${truncate(p.description, 80)}` : "";
  const defaultPrice = p.default_price ? ` · default_price=${p.default_price}` : "";
  return `${p.id} · ${p.name} [${status}]${modeBadge(p.livemode)}${defaultPrice}${desc} · created ${formatTime(p.created)}`;
}

export function createListProductsTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "list_products",
    description: "List Stripe products. Filter by active state and paginate with starting_after.",
    parameters,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: { limit: number; active?: boolean; starting_after?: string } = { limit: input.limit };
        if (input.active !== undefined) params.active = input.active;
        if (input.starting_after) params.starting_after = input.starting_after;
        const res = await c.products.list(params);
        if (res.data.length === 0) return { content: "No products found." };

        const more = res.has_more ? ` (more available; pass starting_after=${res.data[res.data.length - 1]?.id})` : "";
        const header = `${res.data.length} ${pluralise(res.data.length, "product")}${more}:`;
        return { content: `${header}\n\n${res.data.map(formatLine).join("\n")}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "list_products"), is_error: true };
      }
    },
  };
}
