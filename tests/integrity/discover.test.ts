import { describe, expect, it, vi } from "vitest";
import { CONFIG_NAME, listConfigFiles } from "../../scripts/integrity/discover.js";
import type { IntegrityFs } from "../../scripts/integrity/discover.js";
import { ROOT, errno, fakeFs } from "./fake-fs.js";

async function paths(fs: IntegrityFs): Promise<string[]> {
  return (await listConfigFiles(ROOT, fs)).map((file) => file.path);
}

describe("CONFIG_NAME", () => {
  it.each([
    "eslint.config.js",
    "vite.config.ts",
    "vitest.conformance.config.ts",
    "x.config.mjs",
    "x.config.cjs",
    "x.config.mts",
    "x.config.cts",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.mjs",
    "vitest.workspace.ts",
    "vitest.workspace.js",
    "vitest.workspace.mjs",
  ])("includes %s", (name) => {
    expect(CONFIG_NAME.test(name)).toBe(true);
  });

  it.each(["config.js", "eslint.config.json", ".eslintrc.json", "README.md", "tsconfig.json", "x.config.js.bak"])(
    "excludes %s",
    (name) => {
      expect(CONFIG_NAME.test(name)).toBe(false);
    },
  );
});

describe("listConfigFiles", () => {
  it("lists the root and each workspace one level deep, sorted", async () => {
    const fs = fakeFs({
      files: {
        "vitest.config.ts": "",
        "eslint.config.js": "",
        "voices/db/vitest.config.ts": "",
        "packages/web/vite.config.ts": "",
        "packages/web/package.json": "",
      },
    });
    expect(await paths(fs)).toEqual([
      "eslint.config.js",
      "packages/web/vite.config.ts",
      "vitest.config.ts",
      "voices/db/vitest.config.ts",
    ]);
  });

  it("never looks in tests/, scripts/, node_modules/, dist/ or below a workspace's root", async () => {
    const fs = fakeFs({
      files: {
        "eslint.config.js": "",
        "tests/eslint.config.js": "",
        "scripts/x.config.js": "",
        "node_modules/pkg/x.config.js": "",
        "packages/web/dist/x.config.js": "",
        "packages/web/src/x.config.ts": "",
        "packages/x.config.js": "",
      },
    });
    expect(await paths(fs)).toEqual(["eslint.config.js"]);
  });

  it("lists a symlinked config as a symlink", async () => {
    const fs = fakeFs({ files: { "eslint.config.js": "" }, symlinks: ["packages/web/vite.config.ts"] });
    const files = await listConfigFiles(ROOT, fs);
    expect(files).toEqual([
            { path: "eslint.config.js", absolute: "/repo/eslint.config.js", symlink: false },
      { path: "packages/web/vite.config.ts", absolute: "/repo/packages/web/vite.config.ts", symlink: true },
    ]);
  });

  it("lists a symlinked workspace directory as a symlink and does not enter it", async () => {
    const fs = fakeFs({
      files: { "eslint.config.js": "", "packages/real/vite.config.ts": "" },
      symlinks: ["packages/web", "voices/linked"],
    });
    const readdir = vi.spyOn(fs, "readdir");
    const files = await listConfigFiles(ROOT, fs);
    expect(files).toEqual([
      { path: "eslint.config.js", absolute: "/repo/eslint.config.js", symlink: false },
      { path: "packages/real/vite.config.ts", absolute: "/repo/packages/real/vite.config.ts", symlink: false },
      { path: "packages/web", absolute: "/repo/packages/web", symlink: true },
      { path: "voices/linked", absolute: "/repo/voices/linked", symlink: true },
    ]);
    expect(readdir).not.toHaveBeenCalledWith("/repo/packages/web");
    expect(readdir).not.toHaveBeenCalledWith("/repo/voices/linked");
  });

  it("scans docs/, the Astro site, one level deep", async () => {
    const fs = fakeFs({
      files: { "eslint.config.js": "", "docs/astro.config.mjs": "", "docs/src/content.config.ts": "" },
    });
    expect(await paths(fs)).toEqual(["docs/astro.config.mjs", "eslint.config.js"]);
  });

  it("treats missing packages/ and voices/ as empty", async () => {
    expect(await paths(fakeFs({ files: { "eslint.config.js": "" } }))).toEqual(["eslint.config.js"]);
  });

  it("returns nothing for an empty repository", async () => {
    expect(await paths(fakeFs({ files: {} }))).toEqual([]);
  });

  it("rethrows a directory error other than ENOENT", async () => {
    const fs: IntegrityFs = {
      readdir: () => Promise.reject(errno("EACCES")),
      readFile: () => Promise.resolve(""),
    };
    await expect(listConfigFiles(ROOT, fs)).rejects.toThrow("EACCES");
  });
});
