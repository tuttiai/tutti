import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type { ScoreResult } from "../golden/types.js";
import type { Scorer, ScorerInput } from "./types.js";

/**
 * Shape a user-provided scorer module must export as its default. The
 * arguments mirror what the spec promised:
 *
 *     export default async function score(
 *       input: string,
 *       output: string,
 *       expected: string | undefined,
 *     ): Promise<ScoreResult>
 *
 * The returned `scorer` name is kept verbatim — the registry does not
 * rewrite it — so custom scorers can key results under a descriptive
 * label.
 */
export type CustomScorerFn = (
  input: string,
  output: string,
  expected: string | undefined,
) => Promise<ScoreResult>;

/**
 * Dynamic-import wrapper around a user-provided scorer file.
 *
 * The module path is resolved against the process CWD (matching the
 * existing {@link ScoreLoader} convention) and loaded lazily on first
 * score so a case with a broken path only fails that scorer rather
 * than the whole run setup. The module is cached after the first
 * successful load — re-imports would thrash the ESM module graph.
 */
export class CustomScorer implements Scorer {
  readonly name: string;
  private readonly modulePath: string;
  private cachedFn: CustomScorerFn | undefined;

  constructor(modulePath: string) {
    this.modulePath = modulePath;
    // Namespace the result key by path so multiple custom scorers on
    // the same case don't collide on `scores.custom`.
    this.name = "custom:" + modulePath;
  }

  async score(input: ScorerInput): Promise<ScoreResult> {
    let fn: CustomScorerFn;
    try {
      fn = await this.loadFn();
    } catch (err) {
      return {
        scorer: this.name,
        score: 0,
        passed: false,
        detail:
          "failed to load custom scorer '" +
          this.modulePath +
          "': " +
          (err instanceof Error ? err.message : String(err)),
      };
    }

    try {
      return await fn(input.input, input.output, input.expected_output);
    } catch (err) {
      return {
        scorer: this.name,
        score: 0,
        passed: false,
        detail:
          "custom scorer threw: " +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  private async loadFn(): Promise<CustomScorerFn> {
    if (this.cachedFn) return this.cachedFn;
    const absolute = resolve(this.modulePath);
    const url = pathToFileURL(absolute).href;
    const mod = (await import(url)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(
        "module has no default export — expected 'export default async function score(...)'",
      );
    }
    this.cachedFn = mod.default as CustomScorerFn;
    return this.cachedFn;
  }
}
