import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ScoreConfig } from "@tuttiai/types";
import { validateScore } from "./score-schema.js";

export class ScoreLoader {
  /**
   * Dynamically import a tutti.score.ts file and return its config.
   * Expects the file to `export default defineScore({ ... })`.
   */
  static async load(path: string): Promise<ScoreConfig> {
    const absolute = resolve(path);
    const url = pathToFileURL(absolute).href;

    const mod = (await import(url)) as { default?: ScoreConfig };

    if (!mod.default) {
      throw new Error(
        `Score file has no default export: ${path}\n` +
        `Your score must use: export default defineScore({ ... })\n` +
        `See https://docs.tutti-ai.com/getting-started/core-concepts`,
      );
    }

    validateScore(mod.default);

    return mod.default;
  }
}
