import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  name: z.string().min(1).max(250).describe("Customer-facing product name"),
  description: z.string().max(40_000).optional().describe("Customer-facing description"),
  active: z.boolean().default(true).describe("Whether the product is currently sellable"),
  metadata: z.record(z.string(), z.string()).optional(),
});

export function createCreateProductTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_product",
    description: "Create a new Stripe product. Pair with create_price to make it sellable.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          name: string;
          description?: string;
          active?: boolean;
          metadata?: Record<string, string>;
        } = { name: input.name, active: input.active };
        if (input.description) params.description = input.description;
        if (input.metadata) params.metadata = input.metadata;
        const product = await c.products.create(params);
        return { content: `Created product ${product.id} (${product.name})${modeBadge(product.livemode)}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, "create_product"), is_error: true };
      }
    },
  };
}
