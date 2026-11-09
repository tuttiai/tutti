import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EXIT_FAIL, EXIT_INCOMPLETE, EXIT_PASS } from "../../docs/scripts/samples/report.js";
import { SKIP_LIST, run } from "../../docs/scripts/samples/run.js";
import { ROOT, captureWriter, fakeFs } from "./fake-fs.js";
import type { FakeTree } from "./fake-fs.js";

const PAGE = "docs/src/content/docs/guides/x.mdx";
const BT = "```";
const MDX = ["# Guide", "## Setup", `${BT}ts`, "const a: number = 1;", BT, "## Usage", `${BT}ts`, "run(score);", BT].join("\n");
const BUILT = {
  "packages/core/package.json": JSON.stringify({ types: "./dist/index.d.ts" }),
  "packages/core/dist/index.d.ts": "",
};

function skip(...samples: unknown[]): string {
  return JSON.stringify({ samples });
}

async function runOn(tree: FakeTree, root: string = ROOT): Promise<{ code: number; out: string[]; err: string[] }> {
  const { write, out, err } = captureWriter();
  const code = await run({ root, fs: fakeFs({ ...BUILT, ...tree }, root), write, ts });
  return { code, out, err };
}

const USAGE = { file: PAGE, heading: "usage", index: 1, reason: "partial snippet: uses run and score (TS2304)" };

describe("run", () => {
  it("exits 0 when every sample passes or is skipped", async () => {
    const result = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip(USAGE) });
    expect(result).toEqual({ code: EXIT_PASS, out: ["docs:check-samples: 2 checked, 1 passed, 1 skipped, 0 failed, 0 stale"], err: [] });
  });

  it("exits 1 and points at the .mdx line of an unskipped failure", async () => {
    const result = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip() });
    expect(result.code).toBe(EXIT_FAIL);
    expect(result.err[0]).toBe(`${PAGE}:8:1 TS2304 Cannot find name 'run'.`);
    expect(result.err.at(-1)).toBe("docs:check-samples: 2 checked, 1 passed, 0 skipped, 1 failed, 0 stale");
  });

  it("exits 1 on an entry that now passes and on one that names no block", async () => {
    const setup = { ...USAGE, heading: "setup" };
    const result = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip(USAGE, setup, { ...USAGE, index: 2 }) });
    expect(result.code).toBe(EXIT_FAIL);
    expect(result.err).toEqual([
      `${PAGE} (heading "setup", index 1): now passes, remove from skip list`,
      `${PAGE} (heading "usage", index 2): stale entry, no such block`,
      "docs:check-samples: 2 checked, 1 passed, 1 skipped, 0 failed, 2 stale",
    ]);
  });

  it("exits 2 and says to build first when a workspace has no declarations", async () => {
    const result = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip(), "voices/slack/package.json": JSON.stringify({ types: "./dist/index.d.ts" }) });
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err).toEqual(["docs:check-samples: no type declarations in voices/slack; run `npm run build` first"]);
  });

  it("exits 2 when the skip list is missing or invalid, naming every problem", async () => {
    expect((await runOn({ [PAGE]: MDX })).err).toEqual([`docs:check-samples: ${SKIP_LIST} could not be read (ENOENT)`]);
    const bad = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip({ ...USAGE, file: "../../etc/x.mdx" }, { ...USAGE, reason: "" }) });
    expect(bad.code).toBe(EXIT_INCOMPLETE);
    expect(bad.err).toHaveLength(2);
    expect(bad.err[0]).toMatch(/^docs:check-samples: docs\/code-samples\.skip\.json: samples\[0\]\.file: /);
  });

  it("exits 2 when there is no ts or tsx block to check", async () => {
    const result = await runOn({ [PAGE]: `${BT}bash\nnpm i\n${BT}`, [SKIP_LIST]: skip() });
    expect(result).toEqual({ code: EXIT_INCOMPLETE, out: [], err: ["docs:check-samples: no ts or tsx code blocks under docs/, so nothing was checked"] });
  });

  it("exits 2 on global compiler errors instead of blaming every sample", async () => {
    // A root with no node_modules: @types/node cannot be found, as with a broken install.
    const result = await runOn({ [PAGE]: MDX, [SKIP_LIST]: skip() }, "/no-such-docs-samples-root");
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err.at(-1)).toBe("docs:check-samples: global compiler errors, so no sample could be checked");
    expect(result.err[0]).toMatch(/^docs:check-samples: TS2688 /);
  });
});

