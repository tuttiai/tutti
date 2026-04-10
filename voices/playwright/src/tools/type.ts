import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector for the input"),
  text: z.string().describe("Text to type"),
  clear_first: z
    .boolean()
    .default(true)
    .describe("Clear existing value first"),
});

export function createTypeTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "type",
    description: "Type text into an input field",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const locator = page.locator(input.selector);
        await locator.waitFor({ state: "visible" });
        if (input.clear_first) {
          await locator.clear();
        }
        await locator.fill(input.text);
        return { content: `Typed "${input.text}" into ${input.selector}` };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
