import { mkdir, writeFile, chmod, copyFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createLogger } from "@tuttiai/core";

import type { DeployManifest } from "../types.js";

/** Port the Tutti Node server binds to inside the Modal container. */
const DEFAULT_PORT = 3000;
/** Modal function memory when the manifest doesn't pin one. */
const DEFAULT_MEMORY_MB = 2048;
/** Hard cap on a single Modal function invocation. 1h covers long agent runs. */
const FUNCTION_TIMEOUT_SECONDS = 3600;
/** How long Modal waits for the Node server to bind to `DEFAULT_PORT`. */
const STARTUP_TIMEOUT_SECONDS = 120;
/**
 * Version of the `tutti-ai` CLI installed into the image. `latest` keeps the
 * generated file stable across releases; users wanting a reproducible build
 * edit the constant in the emitted `modal_app.py`.
 */
const DEFAULT_CLI_VERSION = "latest";

const log = createLogger("deploy:modal");

/**
 * Convert a manifest memory string (e.g. `"512mb"`, `"1gb"`) into the integer
 * megabyte value Modal's `@app.function(memory=...)` expects. Falls back to
 * {@link DEFAULT_MEMORY_MB} when unset — Modal requires an integer, so unlike
 * docker we cannot just omit the field.
 */
function memoryToMb(memory: string | undefined): number {
  if (memory === undefined) return DEFAULT_MEMORY_MB;
  const match = /^(\d+)(mb|gb)$/i.exec(memory);
  if (match === null) return DEFAULT_MEMORY_MB;
  const [, raw, unit] = match;
  if (raw === undefined || unit === undefined) return DEFAULT_MEMORY_MB;
  const n = Number(raw);
  return unit.toLowerCase() === "gb" ? n * 1024 : n;
}

/**
 * Map an env-var name to the Modal secret name the deploy script provisions.
 * `ANTHROPIC_API_KEY` → `tutti-anthropic-api-key`. The `tutti-` prefix keeps
 * the user's Modal secret namespace tidy and matches the example in
 * `deploy.sh`.
 */
function modalSecretName(envVarName: string): string {
  return "tutti-" + envVarName.toLowerCase().replace(/_/g, "-");
}

/**
 * Quote a string for a Python literal. The schema already restricts env-var
 * names and deploy names to ASCII, so this just escapes backslashes and
 * single quotes — enough for the only strings we emit (names, paths, env
 * values).
 */
function quotePy(s: string): string {
  return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/** Emit `NAME = modal.Secret.from_name('tutti-name')` lines for every secret. */
function buildSecretDeclarations(secrets: readonly string[]): string {
  return secrets
    .map((name) => `${name} = modal.Secret.from_name(${quotePy(modalSecretName(name))})`)
    .join("\n");
}

/** Emit the comma-separated list of Secret identifiers for `secrets=[...]`. */
function buildSecretRefs(secrets: readonly string[]): string {
  return secrets.join(", ");
}

/** Emit the `env={...}` dict literal for plaintext env vars on the function. */
function buildEnvDict(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return "{}";
  const inner = entries
    .map(([k, v]) => `${quotePy(k)}: ${quotePy(v)}`)
    .join(", ");
  return `{${inner}}`;
}

/**
 * Build the `modal_app.py` file contents for a given manifest.
 *
 * The generated app:
 *  - Uses `modal.Image.from_registry("node:20-bookworm-slim")` so the Tutti
 *    runtime gets Node 20 (the apt-shipped `nodejs` package on Debian is
 *    Node 18 and too old for the CLI).
 *  - Installs `tutti-ai@<version>` and `@tuttiai/cli@<version>` globally.
 *  - Mounts the score file at `/app/tutti.score.ts` via `add_local_file`.
 *  - Exposes the Node server on port {@link DEFAULT_PORT} through
 *    `@modal.web_server` — Modal's primitive for proxying non-Python servers.
 *    The Node server already routes `/messages`, so no extra wiring is needed.
 *  - Declares each `manifest.secrets` entry as a `modal.Secret.from_name(...)`
 *    referencing the `tutti-<lowercase-name>` convention.
 *  - Plaintext `manifest.env` values flow in via the function's `env={...}`.
 *
 * Pure function: same manifest in → same file out, no I/O. Side-effecting
 * writes happen in {@link generateModalBundle}.
 *
 * @example
 * const py = buildModalApp(manifest);
 * await writeFile("modal_app.py", py, "utf-8");
 */
export function buildModalApp(manifest: DeployManifest): string {
  const memoryMb = memoryToMb(manifest.scale.memory);
  const secretsDecl = buildSecretDeclarations(manifest.secrets);
  const secretsRef = buildSecretRefs(manifest.secrets);
  const envDict = buildEnvDict(manifest.env);

  const lines: string[] = [];
  lines.push("import subprocess");
  lines.push("");
  lines.push("import modal");
  lines.push("");
  lines.push(`APP_NAME = ${quotePy(manifest.name)}`);
  lines.push(`CLI_VERSION = ${quotePy(DEFAULT_CLI_VERSION)}  # pin to a specific @tuttiai/cli version for reproducible builds`);
  lines.push("");
  lines.push("image = (");
  lines.push('    modal.Image.from_registry("node:20-bookworm-slim", add_python="3.11")');
  lines.push("    .run_commands(");
  lines.push('        f"npm install -g tutti-ai@{CLI_VERSION}",');
  lines.push('        f"npm install -g @tuttiai/cli@{CLI_VERSION}",');
  lines.push("    )");
  lines.push('    .add_local_file("tutti.score.ts", "/app/tutti.score.ts")');
  lines.push(")");
  lines.push("");
  lines.push("app = modal.App(APP_NAME)");
  if (secretsDecl !== "") {
    lines.push("");
    lines.push(secretsDecl);
  }
  lines.push("");
  lines.push("@app.function(");
  lines.push("    image=image,");
  lines.push(`    secrets=[${secretsRef}],`);
  lines.push(`    env=${envDict},`);
  lines.push(`    timeout=${String(FUNCTION_TIMEOUT_SECONDS)},`);
  lines.push(`    memory=${String(memoryMb)},`);
  lines.push(")");
  lines.push(`@modal.web_server(port=${String(DEFAULT_PORT)}, startup_timeout=${String(STARTUP_TIMEOUT_SECONDS)})`);
  lines.push("def serve():");
  lines.push('    subprocess.Popen(["tutti-ai", "serve", "--score", "/app/tutti.score.ts"])');
  lines.push("");
  return lines.join("\n");
}

/**
 * `.env.modal.example` — one `KEY=` line per declared secret so users know
 * which secrets need provisioning in Modal before `modal deploy`.
 */
export function buildModalEnvExample(manifest: DeployManifest): string {
  const lines: string[] = [
    "# Secrets required by this Modal deployment.",
    "# Provision each one with `modal secret create` before running deploy.sh.",
    "",
  ];
  for (const secret of manifest.secrets) {
    lines.push(`${secret}=`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * `deploy.sh` — `modal deploy modal_app.py` with a comment block showing how
 * to provision each secret via `modal secret create`. The script is committed
 * to the bundle output dir; users run it from there.
 */
export function buildModalDeployScript(manifest: DeployManifest): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Provision secrets BEFORE running this script. One Modal secret per name:",
  ];
  if (manifest.secrets.length === 0) {
    lines.push("#   (no secrets declared for this deployment)");
  } else {
    for (const secret of manifest.secrets) {
      lines.push(`#   modal secret create ${modalSecretName(secret)} --env ${secret}=...`);
    }
  }
  lines.push("");
  lines.push("modal deploy modal_app.py");
  lines.push("");
  return lines.join("\n");
}

/**
 * Generate the full Modal bundle (`modal_app.py`, `tutti.score.ts`,
 * `.env.modal.example`, `deploy.sh`) at `outDir`, creating the directory if
 * it doesn't exist. `deploy.sh` is written executable so it can be invoked
 * directly.
 *
 * Unlike {@link import("./fly.js").generateFlyConfig}, Modal needs the score
 * file inside the bundle because `modal_app.py` references it via
 * `add_local_file`. Pass the original score path so we copy it next to the
 * generated python file.
 *
 * @param manifest      - Resolved manifest from `buildDeployManifest`.
 * @param scoreFilePath - Absolute path to the source `tutti.score.ts`.
 * @param outDir        - Destination directory; created if it doesn't exist.
 *
 * @example
 * const manifest = await buildDeployManifest("./tutti.score.ts");
 * await generateModalBundle(manifest, "./tutti.score.ts", "./build/modal");
 */
export async function generateModalBundle(
  manifest: DeployManifest,
  scoreFilePath: string,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const modalAppPath = resolve(outDir, "modal_app.py");
  const scoreDestPath = resolve(outDir, "tutti.score.ts");
  const envExamplePath = resolve(outDir, ".env.modal.example");
  const deployScriptPath = resolve(outDir, "deploy.sh");

  await writeFile(modalAppPath, buildModalApp(manifest), "utf-8");
  await copyFile(scoreFilePath, scoreDestPath);
  await writeFile(envExamplePath, buildModalEnvExample(manifest), "utf-8");
  await writeFile(deployScriptPath, buildModalDeployScript(manifest), "utf-8");
  await chmod(deployScriptPath, 0o755);

  log.info(
    `Generated Modal bundle for "${manifest.name}" at ${outDir}:\n` +
      "  - modal_app.py\n" +
      "  - tutti.score.ts\n" +
      "  - .env.modal.example\n" +
      "  - deploy.sh\n" +
      "Next: cd " + outDir + " && ./deploy.sh",
  );
}
