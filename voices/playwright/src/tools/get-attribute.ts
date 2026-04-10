import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector"),
  attribute: z.string().describe("Attribute name (e.g. href, src, value)"),
});

export function createGetAttributeTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "get_attribute",
    description: "Get an attribute value from an element",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const value = await page.locator(input.selector).getAttribute(input.attribute);

        if (value === null) {
          return {
            content: `Element "${input.selector}" does not have attribute "${input.attribute}"`,
          };
        }
        return { content: value };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
