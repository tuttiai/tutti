import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  line_items: z
    .array(
      z.object({
        price: z.string().min(1).describe("Stripe price id"),
        quantity: z.number().int().min(1).default(1),
      }),
    )
    .min(1)
    .describe("One or more {price, quantity} entries"),
  metadata: z.record(z.string(), z.string()).optional(),
});

export function createCreatePaymentLinkTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "create_payment_link",
    description: "Create a shareable Stripe Payment Link for one or more prices. Returns the URL.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const params: {
          line_items: Array<{ price: string; quantity: number }>;
          metadata?: Record<string, string>;
        } = { line_items: input.line_items };
        if (input.metadata) params.metadata = input.metadata;
        const link = await c.paymentLinks.create(params);
        return {
          content: `Created payment link ${link.id}${modeBadge(link.livemode)}\n${link.url}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, "create_payment_link"), is_error: true };
      }
    },
  };
}
