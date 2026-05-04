import { existsSync } from "node:fs";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execSync, spawnSync } from "node:child_process";

import chalk from "chalk";
import {
  buildDeployManifest,
  buildDockerfile,
  buildDockerignore,
  buildDockerCompose,
  buildDeployScript,
  buildFlyConfig,
  scanForSecrets,
  validateSecrets,
  buildEnvExample,
} from "@tuttiai/deploy";
import type {
  DeployManifest,
  SecretsValidationResult,
} from "@tuttiai/deploy";

/**
 * Targets the CLI knows how to deploy. Strict subset of `DEPLOY_TARGETS`
 * exported by `@tuttiai/deploy`: `cloudflare` is intentionally excluded
 * here because no Worker bundler is wired up yet — we'd rather error loudly
 * than half-deploy.
 */
export const CLI_DEPLOY_TARGETS = ["docker", "railway", "fly"] as const;
export type CliDeployTarget = (typeof CLI_DEPLOY_TARGETS)[number];

/**
 * Options accepted by `tutti-ai deploy`. Mirrors the Commander flag set so
 * the command body stays a thin wrapper. `target`, when set, overrides the
 * target declared in the score; `dryRun` skips every command execution and
 * (for railway) every file write — file generation for docker / fly still
 * runs because the prompt explicitly says "generates all files".
 */
export interface DeployOptions {
  score?: string;
  target?: string;
  dryRun?: boolean;
  outDir?: string;
}

/**
 * One executable command in a {@link DeployPlan}. Stored as `argv` rather
 * than a single string so dry-run rendering can't be tricked by metacharacters
 * in agent names, and so the runtime path uses `spawnSync` (no shell).
 */
export interface DeployCommandStep {
  argv: string[];
  description: string;
}

/**
 * One file the deploy plan will write. Path is resolved against `outDir`
 * upstream so callers don't need to know the destination layout.
 */
export interface DeployFileStep {
  path: string;
  contents: string;
  executable?: boolean;
}

/**
 * Resolved, target-specific deployment plan. Pure function output: every
 * field is fully determined by the manifest + target + outDir, no I/O.
 *
 * The plan is the boundary between testable logic (target resolution, file
 * + command generation) and side-effecting orchestration (file writes,
 * `spawnSync` calls). Tests can compare plans directly.
 */
export interface DeployPlan {
  target: CliDeployTarget;
  manifest: DeployManifest;
  /** Files the runtime will write before any command runs. */
  files: DeployFileStep[];
  /**
   * Platform CLI commands the runtime would invoke in real-run mode. Empty
   * for docker (no platform CLI invocation — user runs `docker build`
   * themselves from the generated bundle).
   */
  commands: DeployCommandStep[];
  /**
   * Required platform CLI binaries. The runtime checks each exists before
   * running any `commands`; missing binaries become a fail-fast error.
   */
  requiredBinaries: Array<{ name: string; installHint: string }>;
  /** User-facing follow-up instructions printed after a successful deploy. */
  nextSteps: string[];
}

const DEFAULT_OUT_DIR = "./.tutti/deploy";

/**
 * Parse the `--target` flag value. Returns `null` for an unset flag (caller
 * falls back to the manifest's target) and throws for an unknown value so
 * the CLI fails fast with a clean message.
 */
export function parseTargetFlag(raw: string | undefined): CliDeployTarget | null {
  if (raw === undefined) return null;
  if ((CLI_DEPLOY_TARGETS as readonly string[]).includes(raw)) {
    return raw as CliDeployTarget;
  }
  throw new Error(
    `Unknown --target "${raw}". Supported: ${CLI_DEPLOY_TARGETS.join(", ")}.`,
  );
}

/**
 * Pick the final target. The `--target` flag wins when set; otherwise the
 * manifest's target is used. The CLI does not yet ship a Cloudflare
 * bundler — fail loud if that's what the score declared.
 */
export function resolveDeployTarget(
  manifest: DeployManifest,
  flag: CliDeployTarget | null,
): CliDeployTarget {
  if (flag !== null) return flag;
  if (manifest.target === "cloudflare") {
    throw new Error(
      "Cloudflare deployment is not yet wired up in the CLI. Pass --target docker|railway|fly to override.",
    );
  }
  return manifest.target;
}

/**
 * Build the deploy plan for the docker target — generates the full bundle
 * (Dockerfile, .dockerignore, docker-compose.yml, deploy.sh) into `outDir`
 * and emits no platform commands; the user runs `docker build` themselves
 * from the next-steps output.
 */
function planDocker(manifest: DeployManifest, outDir: string): DeployPlan {
  const files: DeployFileStep[] = [
    { path: resolve(outDir, "Dockerfile"), contents: buildDockerfile(manifest) },
    { path: resolve(outDir, ".dockerignore"), contents: buildDockerignore() },
    {
      path: resolve(outDir, "docker-compose.yml"),
      contents: buildDockerCompose(manifest),
    },
    {
      path: resolve(outDir, "deploy.sh"),
      contents: buildDeployScript(manifest),
      executable: true,
    },
  ];

  return {
    target: "docker",
    manifest,
    files,
    commands: [],
    requiredBinaries: [],
    nextSteps: [
      `cd ${outDir}`,
      `Run: docker build -t ${manifest.name} . && docker run -p 3000:3000 ${manifest.name}`,
    ],
  };
}

/**
 * Build the deploy plan for railway. Railway deploys directly from source —
 * no manifest-driven file generation — so the plan is the single
 * `railway up` command plus the install-hint for the CLI.
 */
function planRailway(manifest: DeployManifest): DeployPlan {
  return {
    target: "railway",
    manifest,
    files: [],
    commands: [
      {
        argv: ["railway", "up", "--detach", "--service", manifest.name],
        description: "Deploy to Railway",
      },
    ],
    requiredBinaries: [
      {
        name: "railway",
        installHint: "Install Railway CLI: npm i -g @railway/cli",
      },
    ],
    nextSteps: [
      "railway logs              # tail service logs",
      "railway open              # open the deployment URL",
    ],
  };
}

/**
 * Build the deploy plan for fly. Generates `fly.toml` and reuses the docker
 * Dockerfile (fly's `--dockerfile` build path) — both files go in `outDir`
 * — then runs `fly deploy --config fly.toml` from `outDir`.
 */
function planFly(manifest: DeployManifest, outDir: string): DeployPlan {
  const files: DeployFileStep[] = [
    { path: resolve(outDir, "fly.toml"), contents: buildFlyConfig(manifest) },
    { path: resolve(outDir, "Dockerfile"), contents: buildDockerfile(manifest) },
    { path: resolve(outDir, ".dockerignore"), contents: buildDockerignore() },
  ];

  return {
    target: "fly",
    manifest,
    files,
    commands: [
      {
        argv: ["fly", "deploy", "--config", "fly.toml"],
        description: "Deploy to Fly",
      },
    ],
    requiredBinaries: [
      {
        name: "fly",
        installHint:
          "Install Fly CLI: curl -L https://fly.io/install.sh | sh",
      },
    ],
    nextSteps: [
      "fly status                # current Machine state",
      "fly logs                  # stream logs",
    ],
  };
}

/**
 * Build a deploy plan for the chosen target. Pure: same inputs always yield
 * the same plan, so tests compare plans directly without temp dirs or
 * spawned processes.
 */
export function buildDeployPlan(
  manifest: DeployManifest,
  target: CliDeployTarget,
  outDir: string,
): DeployPlan {
  switch (target) {
    case "docker":
      return planDocker(manifest, outDir);
    case "railway":
      return planRailway(manifest);
    case "fly":
      return planFly(manifest, outDir);
  }
}

/**
 * Render a {@link DeployPlan} as the human-readable block printed under
 * `--dry-run`. Lists every file that *would* be written and every command
 * that *would* be invoked so the user can sanity-check the deployment
 * before flipping the flag.
 */
export function formatDryRunPlan(plan: DeployPlan): string {
  const lines: string[] = [];
  lines.push(`Target: ${plan.target}`);
  lines.push(`Name: ${plan.manifest.name}`);
  if (plan.files.length > 0) {
    lines.push("");
    lines.push("Files that would be written:");
    for (const f of plan.files) {
      lines.push(`  - ${f.path}${f.executable === true ? " (executable)" : ""}`);
    }
  }
  if (plan.commands.length > 0) {
    lines.push("");
    lines.push("Commands that would run:");
    for (const c of plan.commands) {
      lines.push(`  - ${c.argv.join(" ")}    # ${c.description}`);
    }
  }
  if (plan.requiredBinaries.length > 0) {
    lines.push("");
    lines.push("Required CLIs:");
    for (const b of plan.requiredBinaries) {
      lines.push(`  - ${b.name}`);
    }
  }
  return lines.join("\n");
}

/**
 * Minimal command runner. Defaults to real `spawnSync` / `execSync`; tests
 * inject a stub so dry-run assertions can prove no real `docker` / `railway`
 * / `fly` invocation happened.
 */
export interface DeployRunner {
  /** True iff `name` is on PATH. */
  which(name: string): boolean;
  /** Stream stdout/stderr through; return the exit status. */
  spawn(argv: string[], opts?: { cwd?: string }): { status: number };
}

const realRunner: DeployRunner = {
  which(name) {
    try {
      execSync(`command -v ${name}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
  spawn(argv, opts) {
    const [cmd, ...rest] = argv;
    if (cmd === undefined) return { status: 1 };
    const result = spawnSync(cmd, rest, {
      stdio: "inherit",
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    return { status: result.status ?? 1 };
  },
};

function fail(msg: string): never {
  console.error(chalk.red("  " + msg));
  process.exit(1);
}

/**
 * Resolve the score path the way every other CLI command does — explicit
 * flag wins, otherwise default to `./tutti.score.ts`. Errors out cleanly
 * when the file is missing rather than letting the dynamic `import()` blow
 * up with an obscure stack trace.
 */
function resolveScorePath(scorePath: string | undefined): string {
  const file = resolve(scorePath ?? "./tutti.score.ts");
  if (!existsSync(file)) {
    fail("Score file not found: " + file);
  }
  return file;
}

async function loadManifest(scorePath: string): Promise<DeployManifest> {
  try {
    return await buildDeployManifest(scorePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail("Deploy validation failed:\n" + msg);
  }
}

/**
 * Render the {@link SecretsValidationResult} for the user. Errors print red
 * (one per line, prefixed `✘`); warnings print yellow (`⚠`); a green
 * confirmation prints when nothing was flagged.
 *
 * The shape mirrors the prompt's exact wording: "Missing required env var:
 * X — add it to deploy.secrets in your score file" / "X is in deploy.env —
 * move it to deploy.secrets to avoid exposing it" / "Secrets validation
 * passed — N secrets will be injected by the platform".
 */
export function printSecretsValidation(result: SecretsValidationResult): void {
  for (const err of result.errors) {
    console.error(chalk.red("  ✘ " + err));
  }
  for (const warn of result.warnings) {
    console.log(chalk.yellow("  ⚠ " + warn));
  }
  if (result.passed && result.warnings.length === 0) {
    const n = result.required.length;
    if (n === 0) {
      console.log(chalk.green("  ✔ Secrets validation passed — no required env vars detected"));
    } else {
      const noun = n === 1 ? "secret" : "secrets";
      console.log(
        chalk.green(
          `  ✔ Secrets validation passed — ${String(n)} ${noun} will be injected by the platform`,
        ),
      );
    }
  } else if (result.passed) {
    console.log(
      chalk.dim(`  Continuing despite ${String(result.warnings.length)} warning(s).`),
    );
  }
}

/**
 * `tutti-ai deploy` entrypoint. Loads the score, builds the manifest, picks
 * a target, and either prints the dry-run plan or executes the runtime path
 * (file writes + platform CLI invocations).
 *
 * Error policy: every recoverable failure short-circuits with `process.exit(1)`
 * after printing a single red line; this matches the surrounding command
 * style (see `check.ts`, `publish.ts`).
 */
export async function deployCommand(
  opts: DeployOptions,
  runner: DeployRunner = realRunner,
): Promise<void> {
  const scorePath = resolveScorePath(opts.score);
  const manifest = await loadManifest(scorePath);

  let target: CliDeployTarget;
  try {
    const flag = parseTargetFlag(opts.target);
    target = resolveDeployTarget(manifest, flag);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  // Static-scan the score + every imported package's entry file for
  // `process.env.X` reads, then verify each required var is declared in
  // `manifest.env` or `manifest.secrets`. Run before any I/O so a missing
  // secret can't half-deploy.
  const required = scanForSecrets(scorePath);
  const validation = validateSecrets(manifest, required);
  console.log();
  console.log(chalk.bold(`  Tutti deploy → ${target}`));
  console.log();
  printSecretsValidation(validation);
  if (!validation.passed) {
    fail("Fix the missing env var declarations and re-run.");
  }

  const outDir = resolve(opts.outDir ?? DEFAULT_OUT_DIR);
  const plan = buildDeployPlan(manifest, target, outDir);
  const envExamplePath = resolve(dirname(scorePath), ".env.deploy.example");

  if (opts.dryRun === true) {
    console.log();
    console.log(formatDryRunPlan(plan));
    console.log();
    console.log(chalk.dim(`  Would also write: ${envExamplePath}`));
    console.log(chalk.dim("  Dry run — nothing was written or executed."));
    return;
  }

  // Real run — write every file the plan declared. mkdir per-file so the
  // plan can mix nested paths in the future without a separate setup step.
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.contents, "utf-8");
    if (file.executable === true) {
      await chmod(file.path, 0o755);
    }
  }
  if (plan.files.length > 0) {
    console.log(chalk.dim(`  Wrote ${String(plan.files.length)} file(s) to ${outDir}`));
  }

  // .env.deploy.example lives next to the score (project root) — it's a
  // reference doc for team onboarding, not a deployment artefact.
  await writeFile(envExamplePath, buildEnvExample(required), "utf-8");
  console.log(chalk.dim(`  Wrote .env.deploy.example to ${envExamplePath}`));

  // Verify required platform CLIs are on PATH before invoking them.
  for (const bin of plan.requiredBinaries) {
    if (!runner.which(bin.name)) {
      fail(`${bin.name} CLI not found. ${bin.installHint}`);
    }
  }

  for (const cmd of plan.commands) {
    console.log(chalk.dim(`  ${cmd.description}: ${cmd.argv.join(" ")}`));
    const cwd = target === "fly" ? outDir : process.cwd();
    const { status } = runner.spawn(cmd.argv, { cwd });
    if (status !== 0) {
      fail(`Command failed (exit ${String(status)}): ${cmd.argv.join(" ")}`);
    }
  }

  console.log();
  console.log(chalk.green(`  Deployed ${manifest.name} to ${plan.target}`));
  if (plan.nextSteps.length > 0) {
    console.log();
    console.log(chalk.dim("  Next steps:"));
    for (const step of plan.nextSteps) {
      console.log(chalk.dim("    " + step));
    }
  }
}

/**
 * Map each target to the platform CLI invocations behind `status`, `logs`,
 * and `rollback`. Centralised so adding a target later (cloudflare,
 * heroku) is a one-place edit. Docker has no platform service to query,
 * so its entries are `null` and the subcommands fail with a clean
 * "not applicable" message.
 */
const SUBCOMMAND_DISPATCH: Record<
  CliDeployTarget,
  {
    status: string[] | null;
    logs: string[] | null;
    logsTail: string[] | null;
    rollback: string[] | null;
    binary: string;
  }
> = {
  docker: {
    status: null,
    logs: null,
    logsTail: null,
    rollback: null,
    binary: "docker",
  },
  railway: {
    status: ["railway", "status"],
    logs: ["railway", "logs"],
    logsTail: ["railway", "logs", "--follow"],
    rollback: ["railway", "rollback"],
    binary: "railway",
  },
  fly: {
    status: ["fly", "status"],
    logs: ["fly", "logs", "--no-tail"],
    logsTail: ["fly", "logs"],
    rollback: ["fly", "releases", "rollback"],
    binary: "fly",
  },
};

async function dispatchSubcommand(
  scorePath: string | undefined,
  pick: (
    entry: typeof SUBCOMMAND_DISPATCH[CliDeployTarget],
  ) => string[] | null,
  label: string,
  runner: DeployRunner,
): Promise<void> {
  const file = resolveScorePath(scorePath);
  const manifest = await loadManifest(file);

  if (manifest.target === "cloudflare") {
    fail(`${label} is not implemented for cloudflare yet.`);
  }
  const target = manifest.target as CliDeployTarget;
  const entry = SUBCOMMAND_DISPATCH[target];
  const argv = pick(entry);
  if (argv === null) {
    fail(
      `${label} is not applicable for target "${target}" — there is no platform service to query.`,
    );
  }
  if (!runner.which(entry.binary)) {
    fail(`${entry.binary} CLI not found.`);
  }
  const { status } = runner.spawn(argv);
  if (status !== 0) {
    fail(`${label} failed (exit ${String(status)})`);
  }
}

/** `tutti-ai deploy status` — dispatch to the platform's status command. */
export async function deployStatusCommand(
  opts: { score?: string },
  runner: DeployRunner = realRunner,
): Promise<void> {
  await dispatchSubcommand(opts.score, (e) => e.status, "deploy status", runner);
}

/** `tutti-ai deploy logs [--tail]` — stream platform logs. */
export async function deployLogsCommand(
  opts: { score?: string; tail?: boolean },
  runner: DeployRunner = realRunner,
): Promise<void> {
  await dispatchSubcommand(
    opts.score,
    (e) => (opts.tail === true ? e.logsTail : e.logs),
    "deploy logs",
    runner,
  );
}

/** `tutti-ai deploy rollback` — roll back to the previous release. */
export async function deployRollbackCommand(
  opts: { score?: string },
  runner: DeployRunner = realRunner,
): Promise<void> {
  await dispatchSubcommand(
    opts.score,
    (e) => e.rollback,
    "deploy rollback",
    runner,
  );
}
