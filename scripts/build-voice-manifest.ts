/**
 * Generate `voice-manifest.json` from every voice's `config-schema.ts`.
 *
 * The manifest is a derived artefact with exactly one source: the zod schema
 * beside each voice. It exists so a consumer that is not this runtime — a
 * graph builder UI, a control plane, the Repertoire — can enumerate the
 * voices and validate a stored `options` object without importing fifteen
 * npm packages or hand-copying their fields.
 *
 * **It is deliberately not the only validator.** JSON Schema cannot express a
 * zod `.refine()`, so any schema carrying one is emitted with
 * `lossy: true` and the rule stated in prose. A consumer that validates only
 * against this file will accept documents the runtime later rejects, which is
 * the failure `spec/agent-graph.md` calls out: the customer finds out after
 * they have left the builder. Validate here to give fast feedback; validate
 * again with the zod schema before deploying.
 *
 * Usage:
 *   npx tsx scripts/build-voice-manifest.ts           write voice-manifest.json
 *   npx tsx scripts/build-voice-manifest.ts --check   exit 1 if it is stale
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VOICES_DIR = join(ROOT, "voices");
const OUTPUT = join(ROOT, "voice-manifest.json");
const MANIFEST_VERSION = 1;

/** One voice as the manifest describes it. */
interface ManifestEntry {
  package: string;
  version: string;
  description: string;
  required_permissions: string[];
  /** True when the zod schema carries a rule JSON Schema cannot express. */
  lossy: boolean;
  /** Prose statement of each rule lost in conversion. Empty when `lossy` is false. */
  unexpressed_rules: string[];
  config: Record<string, unknown>;
}

/**
 * Cross-field rules that live in a `.refine()` and therefore do not survive
 * conversion. Keyed by voice. Stated here so the manifest can carry them as
 * prose rather than dropping them silently.
 *
 * Adding a `.refine()` to a voice schema without adding its rule here makes
 * this script fail, which is the point.
 */
const UNEXPRESSED_RULES: Record<string, string[]> = {
  twitter: [
    "Write access needs all four of api_key, api_secret, access_token and access_token_secret, or none of them. Supplying some but not all is refused.",
  ],
};

/** Read a voice's `required_permissions` without instantiating it. */
function readPermissions(voice: string): string[] {
  const source = readFileSync(join(VOICES_DIR, voice, "src", "index.ts"), "utf8");
  // Anchored to line start so the identifier inside a TSDoc comment (` * `…`)
  // never matches. Covers all three declaration forms present today:
  //   required_permissions: Permission[] = [...]
  //   readonly required_permissions: Permission[] = [...]
  //   required_permissions: [...] satisfies Permission[]
  const match = source.match(
    /^\s*(?:readonly\s+)?required_permissions\s*(?::\s*Permission\[\]\s*)?[:=]\s*\[([^\]]*)\]/m,
  );
  if (!match?.[1]) {
    throw new Error(
      `${voice}: could not read required_permissions from src/index.ts. ` +
        `The declaration form has changed and this script's pattern needs updating. ` +
        `Refusing to emit a manifest that would claim the voice needs no permissions.`,
    );
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

/** Load the exported config schema from a voice's `config-schema.ts`. */
async function loadSchema(voice: string): Promise<z.ZodTypeAny> {
  const module: Record<string, unknown> = await import(
    join(VOICES_DIR, voice, "src", "config-schema.ts")
  );
  const key = Object.keys(module).find((k) => k.endsWith("VoiceConfigSchema"));
  if (!key) {
    throw new Error(`${voice}: config-schema.ts exports no *VoiceConfigSchema`);
  }
  return module[key] as z.ZodTypeAny;
}

/**
 * True when the schema carries a `.refine()` or `.transform()`, which
 * `zodToJsonSchema` silently drops.
 *
 * Reads `_def.typeName` rather than using `instanceof z.ZodEffects`. The
 * schemas arrive through a dynamic `import()`, which resolves zod through a
 * different module registry than this file's static import, so the two
 * `ZodEffects` constructors are not the same object and `instanceof` returns
 * false for a schema that plainly has a refinement. `typeName` is a zod
 * internal, and it is the only identity check that survives that boundary.
 */
function isLossy(schema: z.ZodTypeAny): boolean {
  const def: unknown = (schema as { _def?: unknown })._def;
  if (typeof def !== "object" || def === null) return false;
  const typeName: unknown = (def as { typeName?: unknown }).typeName;
  return typeName === "ZodEffects";
}

async function buildEntry(voice: string): Promise<ManifestEntry> {
  const pkg = JSON.parse(
    readFileSync(join(VOICES_DIR, voice, "package.json"), "utf8"),
  ) as { name: string; version: string; description?: string };

  const schema = await loadSchema(voice);
  const lossy = isLossy(schema);
  const rules = UNEXPRESSED_RULES[voice] ?? [];

  if (lossy && rules.length === 0) {
    throw new Error(
      `${voice}: the schema carries a .refine() whose rule is not stated in ` +
        `UNEXPRESSED_RULES. A manifest that drops a validation rule without ` +
        `saying so is worse than no manifest.`,
    );
  }
  if (!lossy && rules.length > 0) {
    throw new Error(
      `${voice}: UNEXPRESSED_RULES names a rule but the schema has no .refine(). ` +
        `The entry is stale and would mislead a reader.`,
    );
  }

  return {
    package: pkg.name,
    version: pkg.version,
    description: pkg.description ?? "",
    required_permissions: readPermissions(voice),
    lossy,
    unexpressed_rules: rules,
    config: zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "none" }) as Record<
      string,
      unknown
    >,
  };
}

async function main(): Promise<void> {
  const voices = readdirSync(VOICES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const entries: Record<string, ManifestEntry> = {};
  for (const voice of voices) {
    entries[voice] = await buildEntry(voice);
  }

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    note:
      "Generated by scripts/build-voice-manifest.ts. Do not edit. Entries marked lossy " +
      "carry a rule JSON Schema cannot express; validate against the zod schema before deploying.",
    voices: entries,
  };

  const serialised = `${JSON.stringify(manifest, null, 2)}\n`;

  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT, "utf8");
    } catch {
      console.error("voice-manifest.json is missing. Run: npx tsx scripts/build-voice-manifest.ts");
      process.exit(1);
    }
    if (current !== serialised) {
      console.error(
        "voice-manifest.json is stale. Run: npx tsx scripts/build-voice-manifest.ts",
      );
      process.exit(1);
    }
    console.log(`voice-manifest.json is up to date (${voices.length} voices).`);
    return;
  }

  writeFileSync(OUTPUT, serialised);
  const lossyCount = Object.values(entries).filter((e) => e.lossy).length;
  console.log(
    `Wrote voice-manifest.json: ${voices.length} voices, ${lossyCount} carrying an unexpressed rule.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
