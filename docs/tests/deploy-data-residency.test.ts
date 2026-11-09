import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const guidesDir = fileURLToPath(new URL("../src/content/docs/guides/", import.meta.url));
const guide = readFileSync(guidesDir + "deploy.mdx", "utf8");

const RESIDENCY = "## Data residency";
const LIMITS = "## What's not yet shipped";
/** U+2014, built from its code point so this file carries no em dash itself. */
const EM_DASH = String.fromCharCode(0x2014);

/** The text of the h2 section that starts with `heading`, up to the next h2, or "" when absent. */
function section(heading: string): string {
  const start = guide.indexOf("\n" + heading + "\n");
  if (start === -1) return "";
  const next = guide.indexOf("\n## ", start + heading.length + 1);
  return next === -1 ? guide.slice(start) : guide.slice(start, next);
}

/** The anchor Starlight generates for a heading: lower case, punctuation dropped, spaces as hyphens. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Every anchor the headings of the guide produce. */
function anchors(): Set<string> {
  const headings = guide.match(/^#{2,4} .+$/gm) ?? [];
  return new Set(headings.map((line) => slug(line.replace(/^#+ /, ""))));
}

const residency = section(RESIDENCY);

describe("deploy guide: data residency", () => {
  describe("placement", () => {
    it("has one Data residency heading", () => {
      expect(guide.split("\n" + RESIDENCY + "\n")).toHaveLength(2);
      expect(residency).not.toBe("");
    });

    it("sits after Cost monitoring and before What's not yet shipped", () => {
      const at = guide.indexOf(RESIDENCY);
      expect(guide.indexOf("## Cost monitoring after deploy")).toBeLessThan(at);
      expect(at).toBeLessThan(guide.indexOf(LIMITS));
    });
  });

  describe("store table", () => {
    const stores = [
      "InMemorySessionStore", "FileSessionStore", "PostgresSessionStore",
      "MemoryInterruptStore", "PostgresInterruptStore",
      "MemoryCheckpointStore", "PostgresCheckpointStore", "RedisCheckpointStore",
      "InMemorySemanticStore", "MemoryUserMemoryStore", "PostgresUserMemoryStore",
      "InMemoryUserModelStore", "PostgresUserModelStore",
      "MemoryScheduleStore", "PostgresScheduleStore",
      "InMemoryRunCostStore", "PostgresRunCostStore", "InMemoryToolCache",
      "InMemorySkillStore", "InMemoryIdentityStore", "MemoryVectorStore", "PgVectorStore",
      "initTelemetry", "OTLPExporter", "JsonFileExporter", "claude-code-sessions.json",
    ];

    it.each(stores)("names %s", (store) => {
      expect(residency).toContain("`" + store + "`");
    });

    it("keeps the two Postgres variables apart", () => {
      expect(residency).toContain("`memory.url`, else `DATABASE_URL`");
      expect(residency).toContain("server image: `TUTTI_PG_URL`, else `TUTTI_STATE_DIR`");
    });
  });

  describe("what leaves the host", () => {
    it.each(["Model calls", "Claude Code", "Voices", "Registry lookups"])("names %s", (item) => {
      expect(residency).toContain("- **" + item + ".**");
    });

    it("does not claim a region option the providers lack", () => {
      expect(residency).not.toMatch(/region you choose/i);
      expect(residency).toContain("take no endpoint or region option");
    });
  });

  describe("limits", () => {
    it("keeps the AWS / GCP / Azure and Multi-region bullets under What's not yet shipped", () => {
      const limits = section(LIMITS);
      expect(limits).toContain("- **AWS / GCP / Azure**: not yet.");
      expect(limits).toContain("- **Multi-region**: `region: \"auto\"` picks one region.");
    });

    it("links to the limits instead of repeating them", () => {
      expect(residency).toContain("not supported yet; see [What's not yet shipped](#whats-not-yet-shipped)");
      expect(residency).not.toContain("**AWS / GCP / Azure**");
      expect(residency).not.toContain("**Multi-region**");
    });
  });

  describe("links", () => {
    it("points every in-page link at a heading of the guide", () => {
      const targets = [...residency.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
      expect(targets.length).toBeGreaterThan(0);
      const known = anchors();
      for (const target of targets) expect(known.has(target ?? "")).toBe(true);
    });

    it("points every guide link at a page that exists", () => {
      const pages = [...residency.matchAll(/\]\(\/guides\/([a-z0-9-]+)\/\)/g)].map((m) => m[1]);
      expect(pages).toContain("providers");
      for (const page of pages) expect(existsSync(guidesDir + (page ?? "") + ".mdx")).toBe(true);
    });

    it("turns an unknown heading into no section", () => {
      expect(section("## No such heading")).toBe("");
    });
  });

  describe("scope and wording guard", () => {
    it.each(["Tutti Cloud", "Cloudflare", "GDPR", "price", "pricing", "fully private", EM_DASH])(
      "does not contain %s",
      (term) => {
        expect(residency.toLowerCase()).not.toContain(term.toLowerCase());
      },
    );

    it.each([/\bSOC ?2?\b/, /\bsecure\b/i, /\bbest\b/i, /hibernat/i, /snapshot/i])("does not match %s", (pattern) => {
      expect(residency).not.toMatch(pattern);
    });

    it("has no TypeScript code block for check-samples to pick up", () => {
      expect(residency).not.toMatch(/```(ts|tsx|typescript)\b/);
    });
  });
});
