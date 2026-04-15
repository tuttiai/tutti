/**
 * `tutti-ai eval list` — print every golden case alongside its latest
 * recorded run verdict.
 *
 * Thin orchestration over {@link JsonFileGoldenStore} + the pure
 * rendering in `eval-list-render.ts`.
 */

import { JsonFileGoldenStore, type GoldenRun } from "@tuttiai/core";

import { renderGoldenCasesTable } from "./eval-list-render.js";

export async function evalListCommand(): Promise<void> {
  const store = new JsonFileGoldenStore();
  const cases = await store.listCases();

  // One lookup per case — the dataset is expected to be small (tens to
  // hundreds of cases at most); a parallel map keeps the flow simple.
  const latest = await Promise.all(
    cases.map(async (c): Promise<[string, GoldenRun | null]> => [c.id, await store.latestRun(c.id)]),
  );
  const latestByCaseId = new Map<string, GoldenRun | null>(latest);

  console.log(renderGoldenCasesTable(cases, latestByCaseId));
}
