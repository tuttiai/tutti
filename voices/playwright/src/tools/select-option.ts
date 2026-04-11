import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  selector: z.string().describe("CSS selector for the select element"),
  value: z.string().describe("Option value or label to select"),
});

export function createSelectOptionTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "select_option",
    description: "Select an option from a dropdown",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const selected = await page.locator(input.selector).selectOption({
          label: input.value,
        }).catch(() =>
          // Fall back to selecting by value if label didn't match
          page.locator(input.selector).selectOption(input.value),
        );
        return { content: `Selected "${input.value}" from ${input.selector} (${selected.length} option${selected.length === 1 ? "" : "s"})` };
      } catch (error) {
        return { content: pwErrorMessage(error, input.selector), is_error: true };
      }
    },
  };
}
