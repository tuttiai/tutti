import { execFileSync } from "node:child_process";
import { readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepoMap } from "../src/repo-map/repo-map.js";
import { estimateTokens } from "../src/repo-map/render.js";
import { copyFixture, IGNORED_NAMES } from "./fixtures/repo-map/index.js";
import type { FixtureCopy, FixtureName } from "./fixtures/repo-map/index.js";

let copies: FixtureCopy[] = [];

async function fixture(name: FixtureName): Promise<FixtureCopy> {
  const copy = await copyFixture(name);
  copies.push(copy);
  return copy;
}

/** File paths in the order the map lists them. */
function filesIn(text: string): string[] {
  return text.split("\n").filter((l) => l !== "" && !l.startsWith(" ") && !l.startsWith("["));
}

afterEach(async () => {
  await Promise.all(copies.map((c) => c.cleanup()));
  copies = [];
});

describe("buildRepoMap", () => {
  describe("ranking", () => {
    it("puts the file defining widely used symbols first", async () => {
      const { repo, root } = await fixture("ranking");
      const result = await buildRepoMap({ dir: repo, ceiling: root });
      expect(filesIn(result.text)[0]).toBe("src/core/widget-registry.ts");
      expect(result.text).toContain("  5: export function registerWidget(definition: WidgetDefinition): void {");
    });

    it("ranks a file nothing uses below the files that are used", async () => {
      const { repo, root } = await fixture("ranking");
      const files = filesIn((await buildRepoMap({ dir: repo, ceiling: root })).text);
      expect(files.indexOf("src/misc/lonely.ts")).toBeGreaterThan(files.indexOf("src/core/widget-registry.ts"));
    });
  });

  describe("focus", () => {
    it("ranks the more used cluster first without focus", async () => {
      const { repo, root } = await fixture("focus");
      const files = filesIn((await buildRepoMap({ dir: repo, ceiling: root })).text);
      expect(files[0]).toBe("shipping/parcel_router.go");
    });

    it("moves a focused file's cluster to the top", async () => {
      const { repo, root } = await fixture("focus");
      const result = await buildRepoMap({ dir: repo, ceiling: root, focus: ["billing/billing_report.py"] });
      expect(filesIn(result.text).slice(0, 2).sort()).toEqual([
        "billing/billing_report.py",
        "billing/invoice_ledger.py",
      ]);
    });

    it("moves the file defining a focused identifier to the top", async () => {
      const { repo, root } = await fixture("focus");
      const result = await buildRepoMap({ dir: repo, ceiling: root, focus: ["InvoiceLedger"] });
      expect(filesIn(result.text)[0]).toBe("billing/invoice_ledger.py");
    });
  });

  describe("budget", () => {
    it("keeps the map within max_tokens and says what it left out", async () => {
      const { repo, root } = await fixture("focus");
      const full = await buildRepoMap({ dir: repo, ceiling: root, max_tokens: 6000 });
      const small = await buildRepoMap({ dir: repo, ceiling: root, max_tokens: 60 });
      expect(estimateTokens(small.text)).toBeLessThanOrEqual(60);
      expect(small.text.length).toBeLessThan(full.text.length);
      expect(small.text).toMatch(/\[\d+ files and [1-9]\d* definitions left out\./);
      expect(full.text).toContain("[0 files and 0 definitions left out.");
    });

    it("caps max_tokens at 6000", async () => {
      const { repo, root } = await fixture("ranking");
      const result = await buildRepoMap({ dir: repo, ceiling: root, max_tokens: 1_000_000 });
      expect(estimateTokens(result.text)).toBeLessThanOrEqual(6000);
    });
  });

  describe("ignored files", () => {
    it("skips vendored, generated, lock, binary, build and oversized files", async () => {
      const { repo, root } = await fixture("ignored");
      const result = await buildRepoMap({ dir: repo, ceiling: root, max_tokens: 6000 });
      expect(result.text).toContain("keptFunction");
      for (const name of IGNORED_NAMES) expect(result.text).not.toContain(name);
    });

    it("honours .gitignore and includes untracked files in a git repository", async () => {
      const { repo, root } = await fixture("ranking");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      await writeFile(join(repo, ".gitignore"), "src/misc/\n");
      await writeFile(join(repo, "src/untracked.ts"), "export function untrackedThing() {}\n");
      const result = await buildRepoMap({ dir: repo, ceiling: root, max_tokens: 6000 });
      expect(result.text).not.toContain("lonelyHelper");
      expect(result.text).toContain("untrackedThing");
    });
  });

  describe("cache", () => {
    it("answers a second call on an unchanged repository from the cache", async () => {
      const { repo, root, cacheDir } = await fixture("ranking");
      const first = await buildRepoMap({ dir: repo, ceiling: root, cache_dir: cacheDir });
      const second = await buildRepoMap({ dir: repo, ceiling: root, cache_dir: cacheDir });
      expect(first.cache_hits).toBe(0);
      expect(second.cache_hits).toBe(second.files_tagged);
      expect(second.text).toBe(first.text);
      expect(await readdir(cacheDir)).toContain(".gitignore");
    });

    it("re-reads a file whose modification time changed", async () => {
      const { repo, root, cacheDir } = await fixture("ranking");
      await buildRepoMap({ dir: repo, ceiling: root, cache_dir: cacheDir });
      const changed = join(repo, "src/misc/lonely.ts");
      await writeFile(changed, "export function renamedHelper(): number {\n  return 1;\n}\n");
      await utimes(changed, new Date(), new Date(Date.now() + 5000));
      const second = await buildRepoMap({ dir: repo, ceiling: root, cache_dir: cacheDir, max_tokens: 6000 });
      expect(second.cache_hits).toBe(second.files_tagged - 1);
      expect(second.text).toContain("renamedHelper");
    });
  });

  describe("limits", () => {
    it("renders what it has when the time budget runs out", async () => {
      const { repo, root } = await fixture("ranking");
      let t = 0;
      const result = await buildRepoMap({ dir: repo, ceiling: root, time_budget_ms: 2, now: () => t++ });
      expect(result.timed_out).toBe(true);
      expect(result.files_tagged).toBeLessThan(result.files_listed);
      expect(result.text).toMatch(/\[Stopped at the time limit: \d+ files were not read\.\]/);
    });

    it("reads at most max_files files and says how many it skipped", async () => {
      const { repo, root } = await fixture("ranking");
      const result = await buildRepoMap({ dir: repo, ceiling: root, max_files: 2 });
      expect(result.files_listed).toBe(2);
      expect(result.text).toContain("4 more were skipped");
    });
  });
});
