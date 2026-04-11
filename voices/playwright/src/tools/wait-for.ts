import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().optional().describe("Wait for this element"),
  timeout: z.number().int().default(5000).describe("Max wait in ms"),
  state: z
    .enum(["visible", "hidden", "attached", "detached"])
    .default("visible")
    .describe("Element state to wait for"),
});

export function createWaitForTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "wait_for",
    description: "Wait for an element or condition",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();

        if (input.selector) {
          await page.locator(input.selector).waitFor({
            state: input.state,
            timeout: input.timeout,
          });
          return { content: `Element "${input.selector}" is now ${input.state}` };
        }

        // No selector — just wait for the timeout
        await page.waitForTimeout(input.timeout);
        return { content: `Waited ${input.timeout}ms` };
      } catch (error) {
        return { content: pwErrorMessage(error, input.selector), is_error: true };
      }
    },
  };
}
