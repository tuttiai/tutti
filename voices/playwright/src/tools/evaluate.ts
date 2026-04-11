import { z } from "zod";
import type { Tool } from "@tuttiai/types";
import type { BrowserManager } from "../browser.js";
import { pwErrorMessage } from "../utils/format.js";

const parameters = z.object({
  script: z.string().describe("JavaScript to execute in the browser"),
});

export function createEvaluateTool(browser: BrowserManager): Tool<z.infer<typeof parameters>> {
  return {
    name: "evaluate",
    description: "Execute JavaScript in the browser and return the result",
    parameters,
    execute: async (input) => {
      try {
        const page = await browser.getPage();
        const result = await page.evaluate(input.script);
        const output =
          result === undefined
            ? "(undefined)"
            : typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2);
        return { content: output };
      } catch (error) {
        return { content: pwErrorMessage(error, input.script), is_error: true };
      }
    },
  };
}
