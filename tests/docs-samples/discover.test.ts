import { describe, expect, it } from "vitest";
import { listMdxFiles, missingBuilds } from "../../docs/scripts/samples/discover.js";
import { ROOT, fakeFs } from "./fake-fs.js";

const TYPES = JSON.stringify({ name: "@tuttiai/core", types: "./dist/index.d.ts" });

describe("listMdxFiles", () => {
  it("lists .mdx files under docs/, sorted, skipping node_modules, dist and .astro", async () => {
    const fs = fakeFs({
      "docs/src/content/docs/b.mdx": "",
      "docs/src/content/docs/guides/a.mdx": "",
      "docs/src/content/docs/404.md": "",
      "docs/node_modules/pkg/readme.mdx": "",
      "docs/dist/page.mdx": "",
      "docs/.astro/gen.mdx": "",
      "packages/core/README.mdx": "",
    });
    expect(await listMdxFiles(ROOT, fs)).toEqual(["docs/src/content/docs/b.mdx", "docs/src/content/docs/guides/a.mdx"]);
  });
});

describe("missingBuilds", () => {
  it("names packages whose types file is missing and ignores those that declare none", async () => {
    const fs = fakeFs({
      "packages/core/package.json": TYPES,
      "packages/core/dist/index.d.ts": "",
      "packages/cli/package.json": JSON.stringify({ name: "@tuttiai/cli" }),
      "voices/slack/package.json": TYPES,
      "voices/slack/src/index.ts": "",
      "voices/odd/package.json": "{ not json",
      "voices/numeric/package.json": JSON.stringify({ types: 3 }),
      "voices/empty/src/index.ts": "",
      "voices/notes.txt": "",
    });
    expect(await missingBuilds(ROOT, fs)).toEqual(["voices/slack"]);
  });

  it("finds nothing missing when every package is built", async () => {
    const fs = fakeFs({ "packages/core/package.json": TYPES, "packages/core/dist/index.d.ts": "", "voices/x/package.json": "null" });
    expect(await missingBuilds(ROOT, fs)).toEqual([]);
  });
});
