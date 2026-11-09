import ts from "typescript";
import { describe, expect, it } from "vitest";
import { compileSamples, compilerOptions, virtualPath } from "../../docs/scripts/samples/compile.js";
import type { Sample } from "../../docs/scripts/samples/types.js";
import { ROOT } from "./fake-fs.js";

const FILE = "docs/src/content/docs/guides/x.mdx";

function sample(index: number, code: string, extra: Partial<Sample> = {}): Sample {
  return { file: FILE, heading: "setup", index, lang: "ts", startLine: 10, indent: 0, code, ...extra };
}

describe("compilerOptions", () => {
  it("is strict, forces each file to be a module and leaves the hygiene flags off", () => {
    const options = compilerOptions(ts);
    expect(options).toMatchObject({ strict: true, noEmit: true, moduleDetection: ts.ModuleDetectionKind.Force });
    expect(options.noUnusedLocals).toBeUndefined();
    expect(options.verbatimModuleSyntax).toBeUndefined();
  });
});

describe("virtualPath", () => {
  it("puts each sample under <root>/.docs-samples, with _ for no heading", () => {
    expect(virtualPath("/repo", sample(2, ""))).toBe(`/repo/.docs-samples/${FILE}/setup-2.ts`);
    expect(virtualPath("/repo", sample(1, "", { heading: "", lang: "tsx" }))).toBe(`/repo/.docs-samples/${FILE}/_-1.tsx`);
  });
});

describe("compileSamples", () => {
  it("passes a sample that type-checks, with node types and top-level await", () => {
    const code = 'import { join } from "node:path";\nconst p: string = join("a", "b");\nawait Promise.resolve(p);';
    const outcome = compileSamples(ts, ROOT, [sample(1, code)]);
    expect(outcome.global).toEqual([]);
    expect(outcome.results).toEqual([{ sample: sample(1, code), diagnostics: [] }]);
  });

  it("maps an error to its line and column in the .mdx file, counting the fence indent", () => {
    const code = "const ok = 1;\n  const n: number = 'text';";
    const [result] = compileSamples(ts, ROOT, [sample(1, code, { startLine: 42, indent: 4 })]).results;
    // Line 2 of the block is .mdx line 43; `n` is at character 8, plus the 4-space fence indent.
    expect(result?.diagnostics).toEqual([
      { line: 43, column: 13, code: 2322, message: "Type 'string' is not assignable to type 'number'." },
    ]);
  });

  it("reports syntax errors too", () => {
    const [result] = compileSamples(ts, ROOT, [sample(1, "{\n  a: 1,\n  b: 2,\n}")]).results;
    expect(result?.diagnostics[0]).toMatchObject({ code: 1005, line: 12 });
  });

  it("keeps blocks apart: the same top-level name in two blocks is no clash", () => {
    const outcome = compileSamples(ts, ROOT, [sample(1, "const runtime = 1;"), sample(2, "const runtime = 'two';")]);
    expect(outcome.results.map((r) => r.diagnostics)).toEqual([[], []]);
  });

  it("checks tsx blocks as tsx", () => {
    const outcome = compileSamples(ts, ROOT, [sample(1, "const view = <div>{1 + 1}</div>;", { lang: "tsx" })]);
    // No React types in the tree, so the opening and closing tags each have an implicit any type;
    // a .ts file would instead fail to parse the JSX at all.
    expect(outcome.results[0]?.diagnostics.map((d) => d.code)).toEqual([7026, 7026]);
  });

  it("does not resolve a relative import to anything on disk", () => {
    const [result] = compileSamples(ts, ROOT, [sample(1, 'import { x } from "./tools.js";\nexport { x };')]).results;
    expect(result?.diagnostics[0]?.code).toBe(2307);
  });
});
