import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createLogger } from "@tuttiai/core";

import type { DeployManifest } from "../types.js";

/** Container port the bundled `@tuttiai/server` binds to. Matches docker.ts. */
const DEFAULT_PORT = 3000;
const HEALTHCHECK_TIMEOUT_SECONDS = 5;
const HEALTHCHECK_GRACE_SECONDS = 10;

const log = createLogger("deploy:fly");

/**
 * Quote a string value for TOML — `fly.toml` follows the standard rules so
 * we double-quote and escape backslashes / double quotes / newlines. Keys
 * never need quoting in this generator because the schema already restricts
 * env names to `[A-Z_][A-Z0-9_]*`.
 */
function quoteToml(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/**
 * Build a `fly.toml` from a {@link DeployManifest}. Pins the app name and
 * primary region from the manifest; emits a single `[[vm]]` block whose
 * memory comes from `manifest.scale.memory` (default `512mb`); emits a
 * single `[[http_service.checks]]` block driven by `manifest.healthCheck`;
 * declares secret names under `[deploy.secrets]` so `fly secrets set` is the
 * documented way to populate them.
 *
 * Plaintext env vars become `[env]` entries. Secrets are referenced by name
 * only — values must be set out-of-band via `fly secrets set`.
 */
export function buildFlyConfig(manifest: DeployManifest): string {
  const lines: string[] = [];
  lines.push(`app = ${quoteToml(manifest.name)}`);
  lines.push(`primary_region = ${quoteToml(manifest.region)}`);
  lines.push("");
  lines.push("[build]");
  lines.push('  dockerfile = "Dockerfile"');
  lines.push("");

  if (Object.keys(manifest.env).length > 0) {
    lines.push("[env]");
    for (const [key, value] of Object.entries(manifest.env)) {
      lines.push(`  ${key} = ${quoteToml(value)}`);
    }
    lines.push("");
  }

  lines.push("[http_service]");
  lines.push(`  internal_port = ${String(DEFAULT_PORT)}`);
  lines.push("  force_https = true");
  lines.push(`  min_machines_running = ${String(manifest.scale.minInstances)}`);
  lines.push("  auto_start_machines = true");
  lines.push('  auto_stop_machines = "stop"');
  lines.push("");
  lines.push("  [[http_service.checks]]");
  lines.push(`    grace_period = "${String(HEALTHCHECK_GRACE_SECONDS)}s"`);
  lines.push(`    interval = "${String(manifest.healthCheck.intervalSeconds)}s"`);
  lines.push(`    timeout = "${String(HEALTHCHECK_TIMEOUT_SECONDS)}s"`);
  lines.push('    method = "get"');
  lines.push(`    path = ${quoteToml(manifest.healthCheck.path)}`);
  lines.push("");

  lines.push("[[vm]]");
  lines.push(`  memory = ${quoteToml(manifest.scale.memory ?? "512mb")}`);
  lines.push("  cpus = 1");

  if (manifest.secrets.length > 0) {
    lines.push("");
    lines.push("# Set these out-of-band before `fly deploy`:");
    for (const secret of manifest.secrets) {
      lines.push(`#   fly secrets set ${secret}=...`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Write `fly.toml` to `outDir`. Creates the directory if missing. The
 * Dockerfile referenced by the config must be generated separately via
 * {@link import("./docker.js").generateDockerBundle} or supplied by the
 * caller — `fly deploy` will not run without one.
 *
 * @param manifest - Resolved manifest from `buildDeployManifest`.
 * @param outDir   - Destination directory; created if it doesn't exist.
 */
export async function generateFlyConfig(
  manifest: DeployManifest,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const path = resolve(outDir, "fly.toml");
  await writeFile(path, buildFlyConfig(manifest), "utf-8");
  log.info(
    `Generated fly.toml for "${manifest.name}" at ${path}. Pair with a Dockerfile (run generateDockerBundle) before \`fly deploy\`.`,
  );
}
