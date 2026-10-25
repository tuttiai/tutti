import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { SenderClient } from "../client.js";
import { withClient } from "../utils/guard.js";

const parameters = z.object({
  email: z.string().email().describe("Email address of the subscriber to delete"),
});

export function createDeleteSubscriberTool(client: SenderClient): Tool<z.infer<typeof parameters>> {
  return {
    name: "delete_subscriber",
    description:
      "Permanently delete a subscriber from Sender, including their group memberships and history. This cannot be undone.",
    parameters,
    destructive: true,
    execute: (input) =>
      withClient(client, "delete_subscriber", async (api) => {
        const res = await api.request({ method: "DELETE", path: "/subscribers", body: { subscribers: [input.email] } });
        if (!res.ok) return { content: res.message, is_error: true };
        return { content: `Deletion of ${input.email} queued; Sender completes it shortly.` };
      }),
  };
}
