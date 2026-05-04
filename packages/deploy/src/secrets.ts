import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, isAbsolute, join } from "node:path";

import type { DeployManifest } from "./types.js";

/**
 * Result of {@link validateSecrets}. `passed` is shorthand for `errors.length === 0`
 * — kept on the result so callers can check it without importing helpers, and
 * tests can assert against a single discriminator.
 */
export interface SecretsValidationResult {
  /** Hard failures — block deployment. */
  errors: string[];
  /** Suspicious-but-not-blocking findings — surface to the user, allow the run. */
  warnings: string[];
  /** Sorted union of `manifest.env` keys and `manifest.secrets`. */
  declared: string[];
  /** Sorted list of required env vars seen by the static scan. */
  required: string[];
  passed: boolean;
}

/**
 * Names whose substring matches one of these tokens are flagged when they
 * appear in `manifest.env` (plaintext) — almost always a sign the value
 * should have been declared in `manifest.secrets` instead.
 *
 * The list is deliberately broad; false positives cost a yellow line, false
 * negatives leak credentials into checked-in config.
 */
const SECRET_NAME_TOKENS = ["KEY", "TOKEN", "SECRET", "PASSWORD", "API"];

/**
 * Patterns matching env-var reads in JavaScript / TypeScript source. Both
 * accessor styles must be handled because libraries split between them
 * (`process.env.X` for SDK-internal reads, `process.env["X"]` when the name
 * is dynamic-looking but still hard-coded).
 *
 * Pattern only matches `[A-Z_][A-Z0-9_]*` — same shape the rest of the
 * deploy package validates env-var names against, so we don't false-positive
 * on `process.env.NODE_ENV` lookups built into common libraries (it's a
 * legitimate env var that callers don't need to declare).
 */
const ENV_DOTTED = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
const ENV_BRACKETED = /process\.env\[\s*["']([A-Z_][A-Z0-9_]*)["']\s*\]/g;

/**
 * Env vars that the Node runtime sets itself or that every Node project
 * already understands — declaring them in the score's deploy block would be
 * pure noise. Excluded from the required list.
 */
const RUNTIME_BUILTIN_ENV = new Set<string>([
  "NODE_ENV",
  "NODE_OPTIONS",
  "PATH",
  "HOME",
  "PWD",
  "TZ",
  "LANG",
  "LC_ALL",
  "TERM",
  "DEBUG",
  "PORT",
]);

/**
 * Pattern matching `import ... from "<spec>"` and `require("<spec>")`.
 * Captures the module specifier so we can resolve and scan it.
 *
 * We deliberately don't try to handle dynamic `import(expr)` — there's no
 * static way to know what `expr` evaluates to, and the typical use is
 * lazy-loading already-imported packages.
 */
const IMPORT_FROM = /(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g;
const BARE_IMPORT = /import\s+["']([^"']+)["']/g;
const REQUIRE_CALL = /require\(\s*["']([^"']+)["']\s*\)/g;

/**
 * Extract every env-var name read from a single source-text blob. Matches
 * both dotted and bracketed access styles; runtime built-ins are filtered
 * out so the caller's required list doesn't contain noise.
 */
function extractEnvVarNames(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(ENV_DOTTED)) {
    const name = match[1];
    if (name !== undefined && !RUNTIME_BUILTIN_ENV.has(name)) found.add(name);
  }
  for (const match of source.matchAll(ENV_BRACKETED)) {
    const name = match[1];
    if (name !== undefined && !RUNTIME_BUILTIN_ENV.has(name)) found.add(name);
  }
  return [...found];
}

/**
 * Extract every static module specifier mentioned in a source-text blob.
 * Combines all three import shapes (`import x from`, side-effect `import "x"`,
 * `require("x")`) into one deduplicated list.
 */
function extractImportSpecifiers(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(IMPORT_FROM)) {
    const spec = match[1];
    if (spec !== undefined) found.add(spec);
  }
  for (const match of source.matchAll(BARE_IMPORT)) {
    const spec = match[1];
    if (spec !== undefined) found.add(spec);
  }
  for (const match of source.matchAll(REQUIRE_CALL)) {
    const spec = match[1];
    if (spec !== undefined) found.add(spec);
  }
  return [...found];
}

/**
 * Walk up from `fromDir` looking for `node_modules/<spec>`. Returns the
 * absolute package directory or `null` if no parent has it. Mirrors Node's
 * own resolution algorithm closely enough for our scope (we only need to
 * find the package root; the entry file is parsed separately).
 */
function findPackageDir(spec: string, fromDir: string): string | null {
  let dir = fromDir;
  // Loop bounded by the filesystem root — `dirname("/")` returns `"/"` so we
  // detect termination by the equality check.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, "node_modules", spec);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Determine which file Node would execute when this package is `import`ed.
 * Reads `package.json` `exports["."].import` first (modern), then `module`,
 * then `main`, then falls back to `index.js`.
 *
 * Returns `null` if the package doesn't exist or its package.json is
 * malformed — we silently skip such packages so a single broken dependency
 * can't take down the whole scan.
 */
function resolvePackageEntry(packageDir: string): string | null {
  const pkgPath = join(packageDir, "package.json");
  if (!existsSync(pkgPath)) return null;

  let pkg: {
    main?: string;
    module?: string;
    exports?: unknown;
  };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    return null;
  }

  // Try exports["."] first — covers modern packages like all `@tuttiai/*`.
  if (typeof pkg.exports === "object" && pkg.exports !== null) {
    const root = (pkg.exports as Record<string, unknown>)["."];
    if (typeof root === "string") return resolve(packageDir, root);
    if (typeof root === "object" && root !== null) {
      const exp = root as Record<string, unknown>;
      const importEntry = exp.import ?? exp.default ?? exp.require;
      if (typeof importEntry === "string") {
        return resolve(packageDir, importEntry);
      }
    }
  }

  if (typeof pkg.module === "string") return resolve(packageDir, pkg.module);
  if (typeof pkg.main === "string") return resolve(packageDir, pkg.main);

  const indexJs = resolve(packageDir, "index.js");
  return existsSync(indexJs) ? indexJs : null;
}

/**
 * Resolve a relative-path import (`./voices.ts`, `../shared/foo.js`) to an
 * absolute file path. Tries the literal path first; if that doesn't exist,
 * tries the common TS/JS extension swaps (`.js` → `.ts`) so a TypeScript
 * source file imported with a `.js` extension still resolves to the .ts on
 * disk.
 */
function resolveLocalImport(spec: string, fromDir: string): string | null {
  const literal = resolve(fromDir, spec);
  if (existsSync(literal) && statSync(literal).isFile()) return literal;

  const candidates = [
    literal.replace(/\.js$/, ".ts"),
    literal.replace(/\.mjs$/, ".mts"),
    literal + ".ts",
    literal + ".js",
    join(literal, "index.ts"),
    join(literal, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Best-effort source resolution for a single import specifier. Returns the
 * absolute path of the file Node (or the bundler) would load — `null` when
 * the package isn't installed locally or the path can't be resolved.
 *
 * Built-in `node:` modules are intentionally returned as `null` so we don't
 * try to scan them.
 */
function resolveImportSource(spec: string, fromDir: string): string | null {
  if (spec.startsWith("node:") || spec.startsWith("data:")) return null;
  if (spec.startsWith(".") || isAbsolute(spec)) {
    return resolveLocalImport(spec, fromDir);
  }
  // Scoped packages: spec is `@scope/name` or `@scope/name/subpath`.
  // For our purpose (find the package's root), keep just `@scope/name` /
  // `name` — we always scan the package's main entry, not arbitrary subpaths.
  const parts = spec.split("/");
  const pkgName = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (pkgName === undefined || pkgName === "") return null;
  const dir = findPackageDir(pkgName, fromDir);
  if (dir === null) return null;
  return resolvePackageEntry(dir);
}

/**
 * Scan a TypeScript / JavaScript source file (and the entry of every
 * package it directly imports) for env-var reads, returning a sorted,
 * deduplicated list of names.
 *
 * The scan is intentionally **single-level**: we read the score's source
 * and the *first file* of every imported package, but we don't recurse
 * further. That's enough to catch the typical pattern — providers and
 * voices read `process.env.X` (or `SecretsManager.require("X")`, which
 * compiles to a string literal that happens to appear in the same source)
 * directly in their entry file — without making the scan unbounded.
 *
 * Built-in env vars that every Node process inherits (`NODE_ENV`, `PATH`,
 * `HOME`, ...) are filtered out so the caller's `required` list reflects
 * only project-specific config.
 *
 * Resolution failures (missing packages, malformed JSON) are silently
 * ignored — a partial scan is more useful than a hard error, since the
 * caller can still surface anything they did find.
 */
export function scanForSecrets(scoreFilePath: string): string[] {
  const collected = new Set<string>();

  let scoreText: string;
  try {
    scoreText = readFileSync(scoreFilePath, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`scanForSecrets: cannot read ${scoreFilePath}: ${msg}`);
  }

  for (const name of extractEnvVarNames(scoreText)) {
    collected.add(name);
  }

  const scoreDir = dirname(resolve(scoreFilePath));
  const imports = extractImportSpecifiers(scoreText);

  for (const spec of imports) {
    const entry = resolveImportSource(spec, scoreDir);
    if (entry === null) continue;
    let entryText: string;
    try {
      entryText = readFileSync(entry, "utf-8");
    } catch {
      continue;
    }
    for (const name of extractEnvVarNames(entryText)) {
      collected.add(name);
    }
  }

  return [...collected].sort();
}

/**
 * Heuristic: does `name` look like a secret? Used only for warnings — the
 * deploy package's stricter check (env values shaped like API keys) lives
 * in `buildDeployManifest` and runs regardless.
 */
function looksLikeSecret(name: string): boolean {
  return SECRET_NAME_TOKENS.some((t) => name.includes(t));
}

/**
 * Cross-check the manifest's declared env / secrets against the list of
 * required env vars produced by {@link scanForSecrets}.
 *
 * Errors block deployment:
 *  - Required vars not declared in either `env` or `secrets` (the platform
 *    will start the container with the var unset and the agent will fail
 *    on first run).
 *
 * Warnings surface a finding but allow the deploy to continue:
 *  - Names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, or `API` that
 *    appear in `manifest.env` (plaintext config). Almost always a mistake.
 *
 * @param manifest - Resolved manifest from `buildDeployManifest`.
 * @param required - Output of {@link scanForSecrets}.
 * @returns A {@link SecretsValidationResult}.
 */
export function validateSecrets(
  manifest: DeployManifest,
  required: string[],
): SecretsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const envKeys = Object.keys(manifest.env);
  const declared = new Set<string>([...envKeys, ...manifest.secrets]);

  for (const name of required) {
    if (!declared.has(name)) {
      errors.push(
        `Missing required env var: ${name} — add it to deploy.secrets in your score file`,
      );
    }
  }

  for (const key of envKeys) {
    if (looksLikeSecret(key)) {
      warnings.push(
        `${key} is in deploy.env — move it to deploy.secrets to avoid exposing it`,
      );
    }
  }

  return {
    errors,
    warnings,
    declared: [...declared].sort(),
    required: [...required].sort(),
    passed: errors.length === 0,
  };
}

/**
 * Render a `.env.deploy.example` listing every required env var with a
 * placeholder value. The output is deterministic — sorted, fixed header —
 * so a CI diff against a checked-in copy actually shows real changes.
 */
export function buildEnvExample(required: string[]): string {
  const lines: string[] = [];
  lines.push("# Required env vars detected by `tutti-ai deploy`.");
  lines.push("# Set these before deploying. Replace each <placeholder> with a real value.");
  lines.push("# Do NOT commit the populated copy — keep this template only.");
  lines.push("");
  for (const name of [...required].sort()) {
    lines.push(`${name}=<your-${name.toLowerCase().replace(/_/g, "-")}>`);
  }
  if (required.length === 0) {
    lines.push("# (no required env vars detected)");
  }
  lines.push("");
  return lines.join("\n");
}
