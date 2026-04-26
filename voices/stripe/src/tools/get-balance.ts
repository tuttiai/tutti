import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { formatAmount, modeBadge, stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({});

export function createGetBalanceTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_balance",
    description: "Fetch the Stripe account balance with available + pending funds, broken down by currency.",
    parameters,
    execute: async () => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const b = await c.balance.retrieve();
        const fmt = (entries: Array<{ amount: number; currency: string }>) =>
          entries.length === 0
            ? "  (none)"
            : entries.map((e) => `  ${formatAmount(e.amount, e.currency)}`).join("\n");
        return {
          content: `Balance${modeBadge(b.livemode)}\n\nAvailable:\n${fmt(b.available)}\n\nPending:\n${fmt(b.pending)}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, "get_balance"), is_error: true };
      }
    },
  };
}
