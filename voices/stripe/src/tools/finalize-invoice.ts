import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  invoice_id: z.string().min(1).describe("Draft invoice id to finalize (e.g. 'in_...')"),
});

export function createFinalizeInvoiceTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "finalize_invoice",
    description:
      "Finalize a draft invoice — moves it from draft → open and (depending on collection settings) attempts payment.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const inv = await c.invoices.finalizeInvoice(input.invoice_id);
        return {
          content: `Finalized invoice ${inv.id} → status=${inv.status ?? "?"}${inv.hosted_invoice_url ? `\n${inv.hosted_invoice_url}` : ""}`,
        };
      } catch (error) {
        return { content: stripeErrorMessage(error, `invoice ${input.invoice_id}`), is_error: true };
      }
    },
  };
}
