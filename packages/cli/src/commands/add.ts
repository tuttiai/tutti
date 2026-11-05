import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { logger } from "../logger.js";
import { runPackageManager } from "../package-manager.js";
import { PACKAGE_SPEC_HINT, parsePackageSpec } from "../package-spec.js";

const OFFICIAL_VOICES = new Map<string, { package: string; setup: string }>([
  ["filesystem", {
    package: "@tuttiai/filesystem",
    setup: `  Add to your score:
    ${chalk.cyan('import { FilesystemVoice } from "@tuttiai/filesystem"')}
    ${chalk.cyan("voices: [new FilesystemVoice()]")}`,
  }],
  ["github", {
    package: "@tuttiai/github",
    setup: `  Add ${chalk.bold("GITHUB_TOKEN")} to your .env file:
    ${chalk.cyan("GITHUB_TOKEN=ghp_your_token_here")}

  Add to your score:
    ${chalk.cyan('import { GitHubVoice } from "@tuttiai/github"')}
    ${chalk.cyan("voices: [new GitHubVoice()]")}`,
  }],
  ["playwright", {
    package: "@tuttiai/playwright",
    setup: `  Install the browser:
    ${chalk.cyan("npx playwright install chromium")}

  Add to your score:
    ${chalk.cyan('import { PlaywrightVoice } from "@tuttiai/playwright"')}
    ${chalk.cyan("voices: [new PlaywrightVoice()]")}`,
  }],
  ["postgres", {
    package: "@tuttiai/postgres",
    setup: `  Add ${chalk.bold("DATABASE_URL")} to your .env file (${chalk.bold("POSTGRES_URL")} also works):
    ${chalk.cyan("DATABASE_URL=postgres://user:pass@host:5432/dbname")}

  Add to your score:
    ${chalk.cyan('import { PostgresVoice } from "@tuttiai/postgres"')}
    ${chalk.cyan("voices: [new PostgresVoice()]")}
    ${chalk.cyan('permissions: ["network"]')}`,
  }],
]);

/**
 * Resolve what the user typed after `tutti-ai add` to an npm package name.
 *
 * @param input - A short official voice name (e.g. `postgres`), a scoped package or a bare name.
 * @returns The official voice's package, the scoped name unchanged, or `@tuttiai/<input>`.
 */
export function resolvePackageName(input: string): string {
  // Known official voice
  const voice = OFFICIAL_VOICES.get(input);
  if (voice) {
    return voice.package;
  }
  // Already a scoped package
  if (input.startsWith("@")) {
    return input;
  }
  // Try @tuttiai/<name> convention
  return `@tuttiai/${input}`;
}

function isAlreadyInstalled(packageName: string): boolean {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
    return packageName in deps;
  } catch {
    return false;
  }
}

function failInvalid(message: string): never {
  logger.error(message);
  console.error(chalk.dim(PACKAGE_SPEC_HINT));
  process.exit(1);
}

/** Resolve and validate the user's input before anything reaches npm. */
function validateInput(voiceName: string): { spec: string; name: string } {
  if (voiceName.trim() === "") failInvalid("Package name is required.");
  const spec = resolvePackageName(voiceName);
  const parsed = parsePackageSpec(spec);
  if (!parsed.success) failInvalid(`Invalid package name: ${JSON.stringify(voiceName)}`);
  return { spec, name: parsed.data.name };
}

function printSetup(voiceName: string): void {
  const official = OFFICIAL_VOICES.get(voiceName);
  console.log();
  if (official) {
    console.log("  Setup:");
    console.log(official.setup);
  } else {
    console.log(chalk.dim("  Check the package README for setup instructions."));
  }
  console.log();
}

export function addCommand(voiceName: string): void {
  const { spec, name } = validateInput(voiceName);

  // Check if package.json exists in cwd
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    logger.error("No package.json found in the current directory");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project first.'));
    process.exit(1);
  }

  if (isAlreadyInstalled(name)) {
    console.log(chalk.green(`  ✔ ${name} is already installed`));
    return;
  }

  console.log(chalk.cyan(`  Installing ${spec}...`));
  const result = runPackageManager("npm", ["install", spec]);
  if (!result.ok) {
    logger.error(result.error);
    process.exit(1);
  }
  console.log(chalk.green(`  ✔ Installed ${spec}`));
  printSetup(voiceName);
}
