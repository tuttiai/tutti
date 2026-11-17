import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const docsRoot = resolve(__dirname, "..");
const repoRoot = resolve(docsRoot, "..");
const contentRoot = resolve(docsRoot, "src/content/docs");
const pagePath = resolve(contentRoot, "guides/human-approvals.mdx");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** The value of `MEMORY_APPROVALS_WARNING` in a source file, so the page cannot drift from it. */
function memoryWarning(relative: string): string {
  const source = read(resolve(repoRoot, relative));
  const match = /MEMORY_APPROVALS_WARNING =\s*"([^"]+)"/.exec(source);
  if (match?.[1] === undefined) throw new Error(`No MEMORY_APPROVALS_WARNING in ${relative}`);
  return match[1];
}

/** Starlight's heading slug: lower case, punctuation other than - dropped, spaces as -. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .trim()
    .replace(/ /g, "-");
}

function headingSlugs(mdx: string): string[] {
  return [...mdx.matchAll(/^#{2,6} (.+)$/gm)].map((m) => slug(m[1] ?? ""));
}

/** The content file a root-relative docs link points at, or undefined when none exists. */
function contentFile(link: string): string | undefined {
  const route = link.replace(/^\//, "").replace(/\/$/, "");
  return [".mdx", ".md"].map((ext) => resolve(contentRoot, `${route}${ext}`)).find((p) => existsSync(p));
}

const page = existsSync(pagePath) ? read(pagePath) : "";

describe("human approvals guide", () => {
  describe("happy path", () => {
    it("exists with the Human approvals title", () => {
      expect(existsSync(pagePath)).toBe(true);
      expect(page).toMatch(/^---\ntitle: "Human approvals"\n/);
    });

    it("describes requireApproval with its type and the destructive default", () => {
      expect(page).toContain('`string[] | "all" | false`');
      expect(page).toContain("| omitted | tools marked `destructive: true` only |");
      expect(page).toContain("Omitting `requireApproval` is not the same as `false`");
    });

    it.each(["unset, empty or `destructive`", "`none`", "`all`", "a comma-separated list"])(
      "lists the TUTTI_REQUIRE_APPROVAL value %s",
      (value) => {
        expect(page).toContain(`| ${value}`);
      },
    );

    it.each(["postgres", "file", "memory"])("names the %s durability", (durability) => {
      expect(page).toContain(`\`durability: ${durability}\``);
    });

    it.each([
      "packages/core/tests/interrupt/resume-after-restart.test.ts",
      "packages/server/tests/restart.integration.test.ts",
    ])("names the restart test %s, which exists", (testFile) => {
      expect(page).toContain(testFile);
      expect(existsSync(resolve(repoRoot, testFile))).toBe(true);
    });

    it("names the approval endpoints and the stream frame", () => {
      for (const route of ["GET /interrupts/pending", "POST /interrupts/:id/approve", "POST /interrupts/:id/deny"]) {
        expect(page).toContain(route);
      }
      expect(page).toContain("`approval_requested`");
    });
  });

  describe("drift guard", () => {
    it.each([
      ["server image", "packages/server/src/start-stores.ts"],
      ["`tutti-ai serve`", "packages/cli/src/commands/serve-stores.ts"],
    ])("quotes the %s memory warning exactly as %s has it", (label, source) => {
      expect(page).toContain(`- ${label}: "${memoryWarning(source)}"`);
    });

    it("quotes the missing interrupt store error as agent-runner.ts has it", () => {
      const runner = read(resolve(repoRoot, "packages/core/src/agent-runner.ts"));
      expect(runner).toContain("matches requireApproval but no InterruptStore is configured");
      expect(page).toContain("`matches requireApproval but no InterruptStore is configured`");
    });
  });

  describe("rule changes", () => {
    it("states plainly that approvals are not rechecked today", () => {
      expect(page).toContain(
        "Today a pending or approved approval is not rechecked against `requireApproval` or `TUTTI_REQUIRE_APPROVAL` when it is resolved.",
      );
      expect(page).toContain("Voice permissions and `beforeToolCall` hooks are checked again on resume.");
    });

    it.each([/coming soon/i, /\bplanned\b/i, /\bnow rechecks?\b/i, /\bis rechecked\b/i, /\bare rechecked\b/i])(
      "does not claim rechecking on resume has shipped (%s)",
      (phrase) => {
        expect(page).not.toMatch(phrase);
      },
    );

    it("gives a mitigation that uses only endpoints and methods main has", () => {
      expect(page).toContain("### Before you change approval rules");
      expect(page).toContain("`tutti.interruptStore?.listPending()`");
      const runtime = read(resolve(repoRoot, "packages/core/src/runtime.ts"));
      expect(runtime).toContain("async resolveInterrupt(");
      expect(runtime).toContain("readonly interruptStore: InterruptStore | undefined;");
    });
  });

  describe("edge cases and format", () => {
    it("has no em dash", () => {
      expect(page).not.toContain("\u2014");
    });

    it("reads environment variables through SecretsManager in its example", () => {
      expect(page).toContain('SecretsManager.require("TUTTI_PG_URL")');
      expect(page).not.toContain("process.env");
    });

    it("resolves every in-page anchor link", () => {
      const own = headingSlugs(page);
      for (const m of page.matchAll(/\]\(#([^)]+)\)/g)) {
        expect(own).toContain(m[1]);
      }
    });

    it("resolves every root-relative docs link and its anchor", () => {
      const links = [...page.matchAll(/\]\((\/[^)#\s]+)(?:#([^)\s]+))?\)/g)];
      expect(links.length).toBeGreaterThan(0);
      for (const [, path, anchor] of links) {
        const target = contentFile(path ?? "");
        expect(target, `no docs page for ${path ?? ""}`).toBeDefined();
        if (anchor !== undefined && target !== undefined) {
          expect(headingSlugs(read(target))).toContain(anchor);
        }
      }
    });
  });
});
