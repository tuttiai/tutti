import { describe, it, expect, afterAll } from "vitest";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
  scanForSecrets,
  validateSecrets,
  buildEnvExample,
} from "../src/secrets.js";
import type { DeployManifest } from "../src/types.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tutti-deploy-secrets-"));
  created.push(dir);
  return dir;
}

function baseManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    agent_name: "api",
    target: "docker",
    name: "my-agent",
    region: "auto",
    env: {},
    secrets: [],
    scale: { minInstances: 0, maxInstances: 3 },
    healthCheck: { path: "/health", intervalSeconds: 30 },
    services: { postgres: false, redis: false },
    ...overrides,
  };
}

describe("scanForSecrets", () => {
  afterAll(() => {
    for (const d of created) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("finds dotted process.env reads in the score file", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `const k = process.env.OPENAI_API_KEY;
       const db = process.env.DATABASE_URL;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual([
      "DATABASE_URL",
      "OPENAI_API_KEY",
    ]);
  });

  it("finds bracketed process.env reads with both quote styles", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `const a = process.env["GITHUB_TOKEN"];
       const b = process.env['STRIPE_KEY'];`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual([
      "GITHUB_TOKEN",
      "STRIPE_KEY",
    ]);
  });

  it("deduplicates a name read multiple times", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `const a = process.env.ANTHROPIC_API_KEY;
       const b = process.env.ANTHROPIC_API_KEY;
       const c = process.env["ANTHROPIC_API_KEY"];`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("filters out runtime built-ins like NODE_ENV / PATH / PORT", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `if (process.env.NODE_ENV === "production") {}
       const p = process.env.PORT;
       const myKey = process.env.MY_SERVICE_KEY;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual(["MY_SERVICE_KEY"]);
  });

  it("ignores lower-case identifiers (project-style env vars are SHOUTY_SNAKE)", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `const x = process.env.somelowercaseVar;
       const y = process.env.UPPER_CASE_VAR;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual(["UPPER_CASE_VAR"]);
  });

  it("scans relative-path imports", () => {
    const dir = tempDir();
    const helpers = join(dir, "helpers.ts");
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      helpers,
      `export const dbUrl = process.env.DATABASE_URL;`,
      "utf-8",
    );
    writeFileSync(
      score,
      `import { dbUrl } from "./helpers.js";
       const own = process.env.SCORE_OWN_KEY;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual([
      "DATABASE_URL",
      "SCORE_OWN_KEY",
    ]);
  });

  it("scans the entry file of a package found in node_modules", () => {
    const dir = tempDir();
    const pkgDir = join(dir, "node_modules", "@example", "voice");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@example/voice",
        type: "module",
        exports: { ".": { import: "./dist/index.js" } },
      }),
      "utf-8",
    );
    mkdirSync(join(pkgDir, "dist"), { recursive: true });
    writeFileSync(
      join(pkgDir, "dist", "index.js"),
      `export const key = process.env.EXAMPLE_VOICE_TOKEN;`,
      "utf-8",
    );

    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `import { key } from "@example/voice";
       const own = process.env.OWN_KEY;`,
      "utf-8",
    );

    const result = scanForSecrets(score);
    expect(result).toContain("EXAMPLE_VOICE_TOKEN");
    expect(result).toContain("OWN_KEY");
  });

  it("falls back to package.json `main` when `exports` is absent", () => {
    const dir = tempDir();
    const pkgDir = join(dir, "node_modules", "old-pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "old-pkg", main: "lib/main.js" }),
      "utf-8",
    );
    mkdirSync(join(pkgDir, "lib"), { recursive: true });
    writeFileSync(
      join(pkgDir, "lib", "main.js"),
      `module.exports.tok = process.env.OLDPKG_TOKEN;`,
      "utf-8",
    );

    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `const x = require("old-pkg");`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toContain("OLDPKG_TOKEN");
  });

  it("silently skips packages that aren't installed", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `import { whatever } from "@unknown/never-installed";
       const k = process.env.LOCAL_ONLY;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual(["LOCAL_ONLY"]);
  });

  it("silently skips node: built-ins", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(
      score,
      `import { readFile } from "node:fs/promises";
       const k = process.env.MY_KEY;`,
      "utf-8",
    );

    expect(scanForSecrets(score)).toEqual(["MY_KEY"]);
  });

  it("returns an empty array when nothing is read", () => {
    const dir = tempDir();
    const score = join(dir, "tutti.score.ts");
    writeFileSync(score, `export default { agents: {} };`, "utf-8");

    expect(scanForSecrets(score)).toEqual([]);
  });

  it("throws a clear error when the score file does not exist", () => {
    expect(() => scanForSecrets("/tmp/does-not-exist-12345.ts")).toThrow(
      /cannot read/,
    );
  });
});

describe("validateSecrets", () => {
  it("passes when every required var is in manifest.secrets", () => {
    const result = validateSecrets(
      baseManifest({ secrets: ["OPENAI_API_KEY", "DATABASE_URL"] }),
      ["OPENAI_API_KEY", "DATABASE_URL"],
    );

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("passes when a non-secret-shaped var is in manifest.env", () => {
    const result = validateSecrets(
      baseManifest({ env: { LOG_LEVEL: "debug" } }),
      ["LOG_LEVEL"],
    );

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("emits an error for a required var that is declared in neither list", () => {
    const result = validateSecrets(
      baseManifest({ env: { LOG_LEVEL: "info" } }),
      ["LOG_LEVEL", "OPENAI_API_KEY"],
    );

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      "Missing required env var: OPENAI_API_KEY — add it to deploy.secrets in your score file",
    ]);
  });

  it("emits a warning when a secret-shaped name appears in manifest.env", () => {
    const result = validateSecrets(
      baseManifest({
        env: { STRIPE_SECRET_KEY: "sk_live_xxx" },
        secrets: ["STRIPE_SECRET_KEY"],
      }),
      ["STRIPE_SECRET_KEY"],
    );

    // The required var is satisfied (it's in secrets), so no error — but
    // the duplicate plaintext copy in env triggers the warning.
    expect(result.warnings).toContain(
      "STRIPE_SECRET_KEY is in deploy.env — move it to deploy.secrets to avoid exposing it",
    );
  });

  it("flags every secret-shaped token (KEY/TOKEN/SECRET/PASSWORD/API)", () => {
    const result = validateSecrets(
      baseManifest({
        env: {
          MY_API_KEY: "x",
          GITHUB_TOKEN: "x",
          DB_PASSWORD: "x",
          SOME_SECRET: "x",
          API_BASE: "x",
        },
        secrets: ["MY_API_KEY", "GITHUB_TOKEN", "DB_PASSWORD", "SOME_SECRET", "API_BASE"],
      }),
      [],
    );

    expect(result.warnings).toHaveLength(5);
  });

  it("does NOT warn when env keys are clearly non-secret", () => {
    const result = validateSecrets(
      baseManifest({
        env: { LOG_LEVEL: "debug", FEATURE_X: "on", PORT_OVERRIDE: "8080" },
      }),
      [],
    );

    expect(result.warnings).toEqual([]);
  });

  it("collects all errors when multiple required vars are missing", () => {
    const result = validateSecrets(baseManifest(), [
      "A",
      "B",
      "C",
    ]);

    expect(result.errors).toHaveLength(3);
    expect(result.passed).toBe(false);
  });

  it("populates `declared` with the union of env keys and secrets, sorted", () => {
    const result = validateSecrets(
      baseManifest({
        env: { B: "x", A: "x" },
        secrets: ["D", "C"],
      }),
      [],
    );

    expect(result.declared).toEqual(["A", "B", "C", "D"]);
  });

  it("populates `required` sorted regardless of input order", () => {
    const result = validateSecrets(
      baseManifest({ secrets: ["A", "B", "C"] }),
      ["C", "A", "B"],
    );

    expect(result.required).toEqual(["A", "B", "C"]);
  });
});

describe("buildEnvExample", () => {
  it("produces a deterministic header and one line per required var, sorted", () => {
    const out = buildEnvExample(["GITHUB_TOKEN", "ANTHROPIC_API_KEY"]);

    expect(out).toContain("# Required env vars detected by `tutti-ai deploy`");
    expect(out).toContain("ANTHROPIC_API_KEY=<your-anthropic-api-key>");
    expect(out).toContain("GITHUB_TOKEN=<your-github-token>");

    const ankIdx = out.indexOf("ANTHROPIC_API_KEY=");
    const ghIdx = out.indexOf("GITHUB_TOKEN=");
    expect(ankIdx).toBeLessThan(ghIdx); // sorted alphabetically
  });

  it("includes a 'no required env vars' note when the list is empty", () => {
    expect(buildEnvExample([])).toContain("(no required env vars detected)");
  });

  it("warns against committing the populated copy", () => {
    const out = buildEnvExample(["X"]);
    expect(out).toContain("Do NOT commit the populated copy");
  });
});
