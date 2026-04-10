import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  direction: z.enum(["up", "down", "top", "bottom"]).describe("Scroll direction"),
  amount: z.number().int().default(500).describe("Pixels to scroll"),
  selector: z.string().optional().describe("Scroll a specific element instead of the page"),
});

export function createScrollTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "scroll",
    description: "Scroll the page or an element",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const target = input.selector
          ? `document.querySelector(${JSON.stringify(input.selector)})`
          : "window";

        let script: string;
        switch (input.direction) {
          case "down":
            script = `${target}.scrollBy(0, ${input.amount})`;
            break;
          case "up":
            script = `${target}.scrollBy(0, -${input.amount})`;
            break;
          case "top":
            script = `${target}.scrollTo(0, 0)`;
            break;
          case "bottom":
            script = input.selector
              ? `const el = ${target}; el.scrollTo(0, el.scrollHeight)`
              : `window.scrollTo(0, document.body.scrollHeight)`;
            break;
        }

        await page.evaluate(script);
        return { content: `Scrolled ${input.direction}${input.selector ? ` on "${input.selector}"` : ""}` };
      } catch (error) {
        return { content: pwErrorMessage(error), is_error: true };
      }
    },
  };
}
