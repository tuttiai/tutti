import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { StripeClient } from "../client.js";
import { guardClient } from "../utils/guard.js";
import { stripeErrorMessage } from "../utils/format.js";

const parameters = z.object({
  invoice_id: z.string().min(1).describe("Open invoice id to void"),
});

export function createVoidInvoiceTool(client: StripeClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "void_invoice",
    description:
      "Void an open invoice. Once voided, the invoice cannot be paid and the underlying liability is reversed. Voiding is permanent.",
    parameters,
    destructive: true,
    execute: async (input) => {
      const blocked = guardClient(client);
      if (blocked) return blocked;
      if (client.kind !== "ready") return { content: "unreachable", is_error: true };

      try {
        const c = await client.wrapper.getClient();
        const inv = await c.invoices.voidInvoice(input.invoice_id);
        return { content: `Voided invoice ${inv.id} → status=${inv.status ?? "?"}` };
      } catch (error) {
        return { content: stripeErrorMessage(error, `invoice ${input.invoice_id}`), is_error: true };
      }
    },
  };
}
