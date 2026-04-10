import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  path: z.string().describe("Where to save the screenshot (.png)"),
  selector: z.string().optional().describe("Capture a specific element"),
  full_page: z
    .boolean()
    .default(false)
    .describe("Capture full scrollable page"),
});

export function createScreenshotTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "screenshot",
    description: "Take a screenshot of the current page or element",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();

        if (input.selector) {
          const locator = page.locator(input.selector);
          await locator.screenshot({ path: input.path });
          const box = await locator.boundingBox();
          const dims = box ? `${Math.round(box.width)}x${Math.round(box.height)}` : "unknown";
          return { content: `Screenshot of "${input.selector}" saved to ${input.path} (${dims})` };
        }

        await page.screenshot({
          path: input.path,
          fullPage: input.full_page,
        });
        const viewport = page.viewportSize();
        const dims = viewport ? `${viewport.width}x${viewport.height}` : "unknown";
        return { content: `Screenshot saved to ${input.path} (${dims})` };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
