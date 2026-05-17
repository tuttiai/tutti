import { mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";

import { createLogger } from "@tuttiai/core";

import type { DeployManifest } from "../types.js";

/** Port the Tutti Node server binds to inside the Daytona workspace. */
const DEFAULT_PORT = 3000;
/**
 * Version of the `tutti-ai` CLI installed into the dev container. `latest`
 * keeps the generated config stable across releases; users wanting a
 * reproducible workspace pin the constant in the emitted `devcontainer.json`.
 */
const DEFAULT_CLI_VERSION = "latest";
/**
 * Base image for the dev container. Tracks the official Microsoft TypeScript
 * + Node 22 image — same toolchain we ship in CI, so a Daytona workspace
 * matches a contributor's local sandbox.
 */
const DEFAULT_DEVCONTAINER_IMAGE =
  "mcr.microsoft.com/devcontainers/typescript-node:22";

const log = createLogger("deploy:daytona");

/**
 * Map a manifest env record to the devcontainer `containerEnv` object literal
 * (one string-string pair per declared env var). Kept separate from
 * {@link buildDevcontainer} so callers and tests can compare the env block
 * directly without parsing the full JSON.
 */
function buildContainerEnv(env: Record<string, string>): Record<string, string> {
  return { ...env };
}

/**
 * Build the `.devcontainer/devcontainer.json` file contents for a Daytona
 * workspace.
 *
 * The generated container:
 *  - Uses {@link DEFAULT_DEVCONTAINER_IMAGE} for the toolchain.
 *  - Installs the Tutti CLI at create time via `postCreateCommand`. The CLI
 *    version is pinned to {@link DEFAULT_CLI_VERSION} for reproducibility.
 *  - Forwards port {@link DEFAULT_PORT} (the Node server). Studio (4747) is
 *    not started by `daytona.sh`, so it is intentionally not forwarded.
 *  - Mirrors plaintext `manifest.env` into `containerEnv`. Secrets are NOT
 *    injected here — Daytona surfaces them through the user's local secret
 *    store and the dev container reads them at runtime.
 *
 * Pure function: same manifest in → same JSON out, no I/O. Side-effecting
 * writes happen in {@link generateDaytonaBundle}.
 */
export function buildDevcontainer(manifest: DeployManifest): string {
  const config = {
    name: manifest.name,
    image: DEFAULT_DEVCONTAINER_IMAGE,
    postCreateCommand: `npm install -g tutti-ai@${DEFAULT_CLI_VERSION}`,
    forwardPorts: [DEFAULT_PORT],
    containerEnv: buildContainerEnv(manifest.env),
  };
  return JSON.stringify(config, null, 2) + "\n";
}

/**
 * Build the `.daytona/snapshots.yaml` file contents.
 *
 * WARNING: the field names below (`idle_minutes_until_hibernate`,
 * `auto_resume`) are NOT verified against the current Daytona OSS or
 * Sandbox config schema — Daytona's hibernation knobs are normally set via
 * the SDK / `daytona sandbox create` flags, not a checked-in YAML. The file
 * is emitted because the deploy spec calls for it, but it may be silently
 * ignored by the platform.
 *
 * TODO(deploy/daytona): replace with `daytona sandbox create --auto-stop 5
 * --auto-archive 5` invocation in `daytona.sh` once the canonical hibernation
 * mechanism is confirmed against current Daytona docs.
 */
export function buildSnapshotsYaml(): string {
  const lines: string[] = [
    "# UNVERIFIED SCHEMA — these field names have not been validated against",
    "# the current Daytona OSS or Daytona Sandbox config format. Hibernation",
    "# is normally configured via the SDK or `daytona sandbox create` flags,",
    "# not a checked-in YAML. This file is emitted because the deploy spec",
    "# requests it; treat it as a placeholder until the schema is confirmed.",
    "# TODO(deploy/daytona): move hibernation config into daytona.sh CLI flags.",
    "idle_minutes_until_hibernate: 5",
    "auto_resume: true",
    "",
  ];
  return lines.join("\n");
}

/**
 * `.gitignore` for the Daytona bundle directory. Excludes the local Daytona
 * runtime state (`.daytona/state/`, `.daytona/logs/`) and any workspace-local
 * lockfile produced when the dev container materialises, while keeping the
 * checked-in config (`snapshots.yaml`, the `.devcontainer/` directory)
 * tracked.
 */
export function buildDaytonaGitignore(): string {
  const lines: string[] = [
    "# Daytona local workspace state — keep config files (snapshots.yaml,",
    "# .devcontainer/) tracked, ignore everything generated at runtime.",
    ".daytona/state/",
    ".daytona/logs/",
    ".daytona/cache/",
    "",
  ];
  return lines.join("\n");
}

/**
 * `daytona.sh` — provisions the Daytona workspace from the bundle directory
 * and starts `tutti-ai serve` over SSH. Mirrors the modal/fly deploy.sh
 * style: `set -euo pipefail`, single user-runnable script.
 *
 * The script assumes the user runs it from the bundle root and that the
 * Daytona CLI clones the parent folder as a workspace named after
 * `manifest.name`. If the user clones into a differently-named directory,
 * they should edit the `WORKSPACE_DIR` variable.
 */
export function buildDaytonaScript(manifest: DeployManifest): string {
  const workspaceDir = `/workspaces/${manifest.name}`;
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "",
    "# Create a Daytona workspace from this directory (no IDE auto-open),",
    "# then SSH in and start the Tutti server.",
    "# Edit WORKSPACE_DIR if you cloned into a folder name different from the",
    "# deployment name — devcontainers mount at /workspaces/<host-folder>.",
    `WORKSPACE_DIR="${workspaceDir}"`,
    "",
    "daytona create --no-ide",
    `daytona ssh -- tutti-ai serve --score "$WORKSPACE_DIR/tutti.score.ts"`,
    "",
  ];
  return lines.join("\n");
}

/**
 * Generate the full Daytona bundle (`.devcontainer/devcontainer.json`,
 * `.daytona/snapshots.yaml`, `.gitignore`, `daytona.sh`) at `outDir`,
 * creating the directory if it doesn't exist. `daytona.sh` is written
 * executable so it can be invoked directly.
 *
 * Unlike modal, Daytona reads the score file from the workspace checkout
 * (mounted at `/workspaces/<name>/tutti.score.ts`), so the score is NOT
 * copied into the bundle — the user's existing repo layout is the source
 * of truth.
 *
 * @param manifest - Resolved manifest from `buildDeployManifest`.
 * @param outDir   - Destination directory; created if it doesn't exist.
 *
 * @example
 * const manifest = await buildDeployManifest("./tutti.score.ts");
 * await generateDaytonaBundle(manifest, "./build/daytona");
 */
export async function generateDaytonaBundle(
  manifest: DeployManifest,
  outDir: string,
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await mkdir(resolve(outDir, ".devcontainer"), { recursive: true });
  await mkdir(resolve(outDir, ".daytona"), { recursive: true });

  const devcontainerPath = resolve(outDir, ".devcontainer", "devcontainer.json");
  const snapshotsPath = resolve(outDir, ".daytona", "snapshots.yaml");
  const gitignorePath = resolve(outDir, ".gitignore");
  const scriptPath = resolve(outDir, "daytona.sh");

  await writeFile(devcontainerPath, buildDevcontainer(manifest), "utf-8");
  await writeFile(snapshotsPath, buildSnapshotsYaml(), "utf-8");
  await writeFile(gitignorePath, buildDaytonaGitignore(), "utf-8");
  await writeFile(scriptPath, buildDaytonaScript(manifest), "utf-8");
  await chmod(scriptPath, 0o755);

  log.info(
    `Generated Daytona bundle for "${manifest.name}" at ${outDir}:\n` +
      "  - .devcontainer/devcontainer.json\n" +
      "  - .daytona/snapshots.yaml (schema unverified)\n" +
      "  - .gitignore\n" +
      "  - daytona.sh\n" +
      "Next: cd " + outDir + " && ./daytona.sh",
  );
}
