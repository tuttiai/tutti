import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CustomScorer } from "../../../src/eval/scorers/custom.js";
import type { ScorerInput } from "../../../src/eval/scorers/types.js";

function mkInput(
  input: string,
  output: string,
  expected_output?: string,
): ScorerInput {
  return {
    input,
    output,
    tool_sequence: [],
    ...(expected_output !== undefined ? { expected_output } : {}),
  };
}

describe("CustomScorer", () => {
  let dir: string;
  const original = process.cwd();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-custom-scorer-"));
    // CustomScorer resolves paths against process.cwd() — chdir so relative
    // `path` strings in ScorerRef resolve under our tmpdir.
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(original);
    rmSync(dir, { recursive: true, force: true });
  });

  it("invokes the default export with input / output / expected", async () => {
    const modPath = "./scorer.mjs";
    writeFileSync(
      resolve(dir, modPath),
      "export default async function score(input, output, expected) {\n" +
        "  return {\n" +
        "    scorer: 'business-rule',\n" +
        "    score: input === 'q' && output === 'a' && expected === 'a' ? 1 : 0,\n" +
        "    passed: true,\n" +
        "    detail: 'input=' + input + ' output=' + output + ' expected=' + expected,\n" +
        "  };\n" +
        "}\n",
    );

    const scorer = new CustomScorer(modPath);
    const r = await scorer.score(mkInput("q", "a", "a"));
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
    expect(r.scorer).toBe("business-rule");
    expect(r.detail).toContain("input=q");
  });

  it("namespaces its `name` with the module path", () => {
    const scorer = new CustomScorer("./scorers/foo.js");
    expect(scorer.name).toBe("custom:./scorers/foo.js");
  });

  it("returns passed:false with detail when the module has no default export", async () => {
    const modPath = "./no-default.mjs";
    writeFileSync(
      resolve(dir, modPath),
      "export const notDefault = 1;\n",
    );
    const scorer = new CustomScorer(modPath);
    const r = await scorer.score(mkInput("q", "a", "a"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/no default export/);
  });

  it("returns passed:false with detail when the module throws at load time", async () => {
    const modPath = "./crashy.mjs";
    writeFileSync(
      resolve(dir, modPath),
      "throw new Error('boom at load');\n",
    );
    const scorer = new CustomScorer(modPath);
    const r = await scorer.score(mkInput("q", "a", "a"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/failed to load custom scorer.*boom at load/);
  });

  it("returns passed:false with detail when the default export throws", async () => {
    const modPath = "./throws.mjs";
    writeFileSync(
      resolve(dir, modPath),
      "export default async function score() {\n" +
        "  throw new Error('scorer exploded');\n" +
        "}\n",
    );
    const scorer = new CustomScorer(modPath);
    const r = await scorer.score(mkInput("q", "a", "a"));
    expect(r.passed).toBe(false);
    expect(r.detail).toMatch(/custom scorer threw.*scorer exploded/);
  });

  it("caches the module after the first load — subsequent scores re-use it", async () => {
    const modPath = "./counter.mjs";
    writeFileSync(
      resolve(dir, modPath),
      "let n = 0;\n" +
        "export default async function score(input, output) {\n" +
        "  n++;\n" +
        "  return { scorer: 'counter', score: n, passed: true, detail: 'call#' + n };\n" +
        "}\n",
    );
    const scorer = new CustomScorer(modPath);
    const first = await scorer.score(mkInput("", ""));
    const second = await scorer.score(mkInput("", ""));
    // If we re-imported, `n` would reset to 1 each time; since we cache,
    // the counter survives between score() calls.
    expect(first.score).toBe(1);
    expect(second.score).toBe(2);
  });
});
