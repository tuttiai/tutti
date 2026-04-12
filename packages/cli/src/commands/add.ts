import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import { createLogger } from "@tuttiai/core";

const logger = createLogger("tutti-cli");

const OFFICIAL_VOICES: Record<string, { package: string; setup: string }> = {
  filesystem: {
    package: "@tuttiai/filesystem",
    setup: `  Add to your score:
    ${chalk.cyan('import { FilesystemVoice } from "@tuttiai/filesystem"')}
    ${chalk.cyan("voices: [new FilesystemVoice()]")}`,
  },
  github: {
    package: "@tuttiai/github",
    setup: `  Add ${chalk.bold("GITHUB_TOKEN")} to your .env file:
    ${chalk.cyan("GITHUB_TOKEN=ghp_your_token_here")}

  Add to your score:
    ${chalk.cyan('import { GitHubVoice } from "@tuttiai/github"')}
    ${chalk.cyan("voices: [new GitHubVoice()]")}`,
  },
  playwright: {
    package: "@tuttiai/playwright",
    setup: `  Install the browser:
    ${chalk.cyan("npx playwright install chromium")}

  Add to your score:
    ${chalk.cyan('import { PlaywrightVoice } from "@tuttiai/playwright"')}
    ${chalk.cyan("voices: [new PlaywrightVoice()]")}`,
  },
  postgres: {
    package: "pg",
    setup: `  Add ${chalk.bold("DATABASE_URL")} to your .env file:
    ${chalk.cyan("DATABASE_URL=postgres://user:pass@localhost:5432/tutti")}

  Add to your score:
    ${chalk.cyan("memory: { provider: 'postgres' }")}

  Or with an explicit URL:
    ${chalk.cyan("memory: { provider: 'postgres', url: process.env.DATABASE_URL }")}

  Use the async factory for initialization:
    ${chalk.cyan("const tutti = await TuttiRuntime.create(score)")}`,
  },
};

function resolvePackageName(input: string): string {
  // Known official voice
  if (OFFICIAL_VOICES[input]) {
    return OFFICIAL_VOICES[input].package;
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
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return packageName in deps;
  } catch {
    return false;
  }
}

export async function addCommand(voiceName: string): Promise<void> {
  const packageName = resolvePackageName(voiceName);

  // Check if package.json exists in cwd
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    logger.error("No package.json found in the current directory");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project first.'));
    process.exit(1);
  }

  // Check if already installed
  if (isAlreadyInstalled(packageName)) {
    console.log(chalk.green(`  ✔ ${packageName} is already installed`));
    return;
  }

  // Install
  const spinner = ora(`Installing ${packageName}...`).start();

  try {
    execSync(`npm install ${packageName}`, {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    spinner.succeed(`Installed ${packageName}`);
  } catch (error) {
    spinner.fail(`Failed to install ${packageName}`);
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error: message, package: packageName }, "Installation failed");
    process.exit(1);
  }

  // Print setup instructions
  const official = OFFICIAL_VOICES[voiceName];
  if (official) {
    console.log();
    console.log("  Setup:");
    console.log(official.setup);
    console.log();
  } else {
    console.log();
    console.log(
      chalk.dim("  Check the package README for setup instructions."),
    );
    console.log();
  }
}
