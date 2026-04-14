/**
 * `tutti-ai upgrade [voice]` — upgrade a specific voice or all voices.
 *
 * Without arguments: upgrades all installed @tuttiai/* packages.
 * With a voice name: upgrades just that one package.
 *
 * Detects the package manager from lock files and uses the appropriate
 * install command.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";

function detectPackageManager(): "npm" | "yarn" | "pnpm" {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function resolvePackageName(input: string): string {
  const KNOWN = new Map([
    ["filesystem", "@tuttiai/filesystem"],
    ["github", "@tuttiai/github"],
    ["playwright", "@tuttiai/playwright"],
    ["mcp", "@tuttiai/mcp"],
    ["web", "@tuttiai/web"],
    ["sandbox", "@tuttiai/sandbox"],
    ["rag", "@tuttiai/rag"],
    ["core", "@tuttiai/core"],
    ["types", "@tuttiai/types"],
    ["server", "@tuttiai/server"],
  ]);
  return KNOWN.get(input) ?? (input.startsWith("@") ? input : `@tuttiai/${input}`);
}

function getInstalledTuttiPackages(): Map<string, string> {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) return new Map();

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const result = new Map<string, string>();
    if (pkg.dependencies) {
      for (const [name, version] of Object.entries(pkg.dependencies)) {
        if (name.startsWith("@tuttiai/")) result.set(name, version);
      }
    }
    if (pkg.devDependencies) {
      for (const [name, version] of Object.entries(pkg.devDependencies)) {
        if (name.startsWith("@tuttiai/")) result.set(name, version);
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

export function upgradeCommand(target?: string): void {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    console.error(chalk.red("No package.json found in the current directory."));
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  const pm = detectPackageManager();
  const installed = getInstalledTuttiPackages();

  if (installed.size === 0) {
    console.log(chalk.dim("No @tuttiai packages found in this project."));
    return;
  }

  let packages: string[];
  if (target) {
    const resolved = resolvePackageName(target);
    if (!installed.has(resolved)) {
      console.error(chalk.red(resolved + " is not installed in this project."));
      console.error(chalk.dim("Installed: " + [...installed.keys()].join(", ")));
      process.exit(1);
    }
    packages = [resolved + "@latest"];
    console.log(chalk.cyan("  Upgrading " + resolved + "..."));
  } else {
    packages = [...installed.keys()].map((p) => p + "@latest");
    console.log(chalk.cyan("  Upgrading all " + packages.length + " @tuttiai packages..."));
  }

  const installCmd = pm === "yarn"
    ? "yarn add " + packages.join(" ")
    : pm === "pnpm"
      ? "pnpm add " + packages.join(" ")
      : "npm install " + packages.join(" ");

  const spinner = ora("Installing...").start();
  try {
    execSync(installCmd, { cwd: process.cwd(), stdio: "pipe" });
    spinner.succeed("Upgraded " + packages.length + " package(s)");
  } catch {
    spinner.fail("Upgrade failed");
    console.log(chalk.dim("  Run manually: " + installCmd));
    process.exit(1);
  }

  // Show new versions
  console.log();
  const newInstalled = getInstalledTuttiPackages();
  for (const [name, oldVersion] of installed) {
    const newVersion = newInstalled.get(name) ?? oldVersion;
    const oldClean = oldVersion.replace(/^[\^~]/, "");
    const newClean = newVersion.replace(/^[\^~]/, "");
    if (oldClean !== newClean) {
      console.log("  " + chalk.green("↑") + " " + name + " " + chalk.dim(oldClean) + " → " + chalk.green(newClean));
    } else {
      console.log("  " + chalk.dim("=") + " " + name + " " + chalk.dim(newClean) + chalk.dim(" (already latest)"));
    }
  }
  console.log();
}
