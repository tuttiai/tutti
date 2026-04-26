import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  product: z.string().min(1).describe("Stripe product id this price belongs to"),
  currency: z.string().length(3).describe("Three-letter ISO currency code (lowercase)"),
  unit_amount: z
    .number()
    .int()
    .nonnegative()
    .describe("Price in the smallest currency unit (e.g. 999 = $9.99 USD; for JPY pass yen directly)"),
  nickname: z.string().max(100).optional().describe("Internal label for the price"),
  recurring: z
    .object({
      interval: z.enum(["day", "week", "month", "year"]),
      interval_count: z.number().int().min(1).default(1).describe("Bills every N intervals (e.g. 3 months)"),
    })
    .optional()
    .describe("Set for subscription prices; omit for one-time prices"),
});

export function createCreatePriceTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_price",
    description: "Create a Stripe price (one-time or recurring) for an existing product.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          product: string;
          currency: string;
          unit_amount: number;
          nickname?: string;
          recurring?: { interval: "day" | "week" | "month" | "year"; interval_count?: number };
        } = {
          product: input.product,
          currency: input.currency.toLowerCase(),
          unit_amount: input.unit_amount,
        };
        if (input.nickname) params.nickname = input.nickname;
        if (input.recurring) {
          params.recurring = {
            interval: input.recurring.interval,
            interval_count: input.recurring.interval_count,
          };
        }
        const price = await c.prices.create(params);
        return {
          content: `Created price ${price.id} · ${formatAmount(input.unit_amount, input.currency)}${modeBadge(price.livemode)}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, "create_price"), is_error: true };
      }
    },
  };
}
