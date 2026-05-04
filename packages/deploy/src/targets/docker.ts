import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";

import { createLogger } from "@tuttiai/core";

import type { DeployManifest } from "../types.js";

/**
 * Default container port the bundled `@tuttiai/server` binds to. Exposed and
 * health-checked by every artefact this module generates.
 */
const DEFAULT_PORT = 3000;
/** Health-check timeout — short enough to surface a stuck container quickly. */
const HEALTHCHECK_TIMEOUT_SECONDS = 5;
const HEALTHCHECK_RETRIES = 3;

const log = createLogger("deploy:docker");

/**
 * Convert a manifest memory string (e.g. `"512mb"`, `"1gb"`) into the
 * megabyte integer Node's `--max-old-space-size` flag expects. The schema
 * already validated the shape, so the regex is total.
 *
 * Returns `undefined` when `memory` is unset so callers can skip emitting
 * NODE_OPTIONS entirely.
 */
function memoryToMaxOldSpaceMb(memory: string | undefined): number | undefined {
  if (memory === undefined) return undefined;
  const match = /^(\d+)(mb|gb)$/i.exec(memory);
  if (!match) return undefined;
  const [, rawValue, rawUnit] = match;
  if (rawValue === undefined || rawUnit === undefined) return undefined;
  const n = Number(rawValue);
  return rawUnit.toLowerCase() === "gb" ? n * 1024 : n;
}

/**
 * Build the Dockerfile that ships the `@tuttiai/server` runtime. Customised
 * per manifest: `EXPOSE`/health URL pin to the manifest port and path, the
 * health-check interval comes from `manifest.healthCheck.intervalSeconds`,
 * declared env vars become `ENV` directives, and `manifest.scale.memory`
 * (when set) caps Node's heap via `NODE_OPTIONS=--max-old-space-size=...`.
 */
export function buildDockerfile(manifest: DeployManifest): string {
  const port = DEFAULT_PORT;
  const interval = manifest.healthCheck.intervalSeconds;
  const path = manifest.healthCheck.path;
  const heapMb = memoryToMaxOldSpaceMb(manifest.scale.memory);

  const envLines: string[] = [];
  for (const [key, value] of Object.entries(manifest.env)) {
    // Quote values to keep whitespace, hashes, and shell metacharacters intact.
    envLines.push(`ENV ${key}=${JSON.stringify(value)}`);
  }
  if (heapMb !== undefined) {
    envLines.push(`ENV NODE_OPTIONS=--max-old-space-size=${String(heapMb)}`);
  }

  const envBlock = envLines.length > 0 ? envLines.join("\n") + "\n" : "";

  return [
    "FROM node:20-alpine",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm ci --omit=dev",
    "COPY . .",
    `EXPOSE ${String(port)}`,
    envBlock.trimEnd(),
    `HEALTHCHECK --interval=${String(interval)}s --timeout=${String(HEALTHCHECK_TIMEOUT_SECONDS)}s --retries=${String(HEALTHCHECK_RETRIES)} \\`,
    `  CMD wget -qO- http://localhost:${String(port)}${path} || exit 1`,
    'CMD ["node", "dist/server.js"]',
    "",
  ]
    .filter((line, idx, arr) => !(line === "" && idx > 0 && arr[idx - 1] === ""))
    .join("\n");
}

/**
 * Static `.dockerignore` — the same for every deployment. Keeps secrets,
 * tests, and dev-only tooling out of the build context.
 */
export function buildDockerignore(): string {
  return [
    "node_modules",
    ".env",
    ".env.*",
    "*.test.ts",
    ".tutti/",
    "",
  ].join("\n");
}

/**
 * Render docker-compose `environment:` entries. Plaintext env vars become
 * `KEY=value`; secrets become `KEY=${KEY}` so `docker compose` reads them
 * from the surrounding shell or `.env` file rather than committing values.
 */
function buildComposeEnv(manifest: DeployManifest): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(manifest.env)) {
    lines.push(`      - ${key}=${value}`);
  }
  for (const secret of manifest.secrets) {
    lines.push(`      - ${secret}=\${${secret}}`);
  }
  return lines;
}

/**
 * Build a `docker-compose.yml` for local testing. The agent service always
 * runs; postgres / redis are only included when `manifest.services` flagged
 * them (set by `buildDeployManifest` from the score's memory/durable config).
 *
 * Postgres data is persisted in a named volume so `docker compose down` does
 * not wipe it; redis runs ephemeral.
 */
export function buildDockerCompose(manifest: DeployManifest): string {
  const port = DEFAULT_PORT;
  const envLines = buildComposeEnv(manifest);
  const dependsOn: string[] = [];
  if (manifest.services.postgres) dependsOn.push("postgres");
  if (manifest.services.redis) dependsOn.push("redis");

  const lines: string[] = [];
  lines.push("services:");
  lines.push("  agent:");
  lines.push("    build: .");
  lines.push(`    container_name: ${manifest.name}`);
  lines.push("    ports:");
  lines.push(`      - "${String(port)}:${String(port)}"`);
  if (envLines.length > 0) {
    lines.push("    environment:");
    lines.push(...envLines);
  }
  lines.push("    healthcheck:");
  lines.push(
    `      test: ["CMD", "wget", "-qO-", "http://localhost:${String(port)}${manifest.healthCheck.path}"]`,
  );
  lines.push(`      interval: ${String(manifest.healthCheck.intervalSeconds)}s`);
  lines.push(`      timeout: ${String(HEALTHCHECK_TIMEOUT_SECONDS)}s`);
  lines.push(`      retries: ${String(HEALTHCHECK_RETRIES)}`);
  if (dependsOn.length > 0) {
    lines.push("    depends_on:");
    for (const dep of dependsOn) lines.push(`      - ${dep}`);
  }

  if (manifest.services.postgres) {
    lines.push("  postgres:");
    lines.push("    image: postgres:16-alpine");
    lines.push("    environment:");
    lines.push("      - POSTGRES_USER=tutti");
    lines.push("      - POSTGRES_PASSWORD=tutti");
    lines.push("      - POSTGRES_DB=tutti");
    lines.push("    volumes:");
    lines.push("      - postgres-data:/var/lib/postgresql/data");
  }

  if (manifest.services.redis) {
    lines.push("  redis:");
    lines.push("    image: redis:7-alpine");
  }

  if (manifest.services.postgres) {
    lines.push("");
    lines.push("volumes:");
    lines.push("  postgres-data:");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Build the registry push script. `REGISTRY` and `VERSION` are
 * caller-overridable via the environment so the same script works for
 * staging and prod; `NAME` is baked in from the manifest because changing it
 * would break the deployment identity.
 *
 * The smoke-test step (`docker run --rm ... npm test`) deliberately runs the
 * built image — catches a broken bundle before the push goes out.
 */
export function buildDeployScript(manifest: DeployManifest): string {
  const name = manifest.name;
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    'REGISTRY="${REGISTRY:-docker.io/your-org}"',
    `NAME="${name}"`,
    'VERSION="${VERSION:-latest}"',
    "",
    'IMAGE="$REGISTRY/$NAME:$VERSION"',
    "",
    'echo "Building $IMAGE"',
    'docker build -t "$IMAGE" .',
    "",
    'echo "Smoke-testing $IMAGE"',
    'docker run --rm "$IMAGE" npm test',
    "",
    'echo "Pushing $IMAGE"',
    'docker push "$IMAGE"',
    "",
  ].join("\n");
}

/**
 * Generate the full Docker bundle (`Dockerfile`, `.dockerignore`,
 * `docker-compose.yml`, `deploy.sh`) at `outDir`, creating the directory if
 * it doesn't exist. `deploy.sh` is written executable so it can be invoked
 * directly.
 *
 * Logs a summary of every file written and the recommended next steps via
 * the standard Tutti pino logger.
 *
 * @param manifest - Resolved manifest from {@link buildDeployManifest}.
 * @param outDir   - Destination directory for the generated files.
 *
 * @example
 * const manifest = await buildDeployManifest("./tutti.score.ts");
 * await generateDockerBundle(manifest, "./build/docker");
 */
export async function generateDockerBundle(
  manifest: DeployManifest,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const files: Array<{ name: string; content: string; executable?: boolean }> = [
    { name: "Dockerfile", content: buildDockerfile(manifest) },
    { name: ".dockerignore", content: buildDockerignore() },
    { name: "docker-compose.yml", content: buildDockerCompose(manifest) },
    { name: "deploy.sh", content: buildDeployScript(manifest), executable: true },
  ];

  for (const file of files) {
    const path = resolve(outDir, file.name);
    await writeFile(path, file.content, "utf-8");
    if (file.executable === true) {
      await chmod(path, 0o755);
    }
  }

  const summary = [
    `Generated Docker bundle for "${manifest.name}" at ${outDir}:`,
    ...files.map((f) => `  - ${f.name}`),
    "",
    "Next steps:",
    `  1. cd ${outDir}`,
    `  2. docker compose up           # local test`,
    `  3. ./deploy.sh                  # build, smoke-test, push`,
  ].join("\n");

  log.info(summary);
}
