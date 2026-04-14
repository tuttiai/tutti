/**
 * `tutti-ai update` — self-update the CLI and core packages to latest.
 *
 * Detects npm or yarn, runs the appropriate install command to pull
 * the latest versions of @tuttiai/* packages, and prints a before/after
 * version comparison.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";

const TUTTI_PACKAGES = [
  "@tuttiai/core",
  "@tuttiai/cli",
  "@tuttiai/types",
  "@tuttiai/server",
  "@tuttiai/filesystem",
  "@tuttiai/github",
  "@tuttiai/playwright",
  "@tuttiai/mcp",
  "@tuttiai/web",
  "@tuttiai/sandbox",
  "@tuttiai/rag",
];

function getInstalledVersion(pkg: string): string | null {
  try {
    const out = execSync(`npm list ${pkg} --depth=0 --json 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const data = JSON.parse(out) as { dependencies?: Record<string, { version?: string }> };
    const deps = data.dependencies;
    if (!deps) return null;
    for (const [name, info] of Object.entries(deps)) {
      if (name === pkg && info.version) return info.version;
    }
    return null;
  } catch {
    return null;
  }
}

function getLatestVersion(pkg: string): string | null {
  try {
    return execSync(`npm view ${pkg} version 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function detectPackageManager(): "npm" | "yarn" | "pnpm" {
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  return "npm";
}

function isGlobalInstall(): boolean {
  try {
    const globalPrefix = execSync("npm prefix -g", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return process.argv[1]?.startsWith(globalPrefix) ?? false;
  } catch {
    return false;
  }
}

export function updateCommand(): void {
  console.log();
  console.log(chalk.cyan.bold("  Tutti Update"));
  console.log();

  // 1. Check for CLI update (global install)
  const spinner = ora("Checking for updates...").start();

  const cliCurrent = getInstalledVersion("@tuttiai/cli") ?? "unknown";
  const cliLatest = getLatestVersion("@tuttiai/cli");

  spinner.stop();

  if (cliLatest && cliCurrent !== cliLatest) {
    console.log(
      chalk.yellow("  CLI update available: ") +
        chalk.dim(cliCurrent) + " → " + chalk.green(cliLatest),
    );

    if (isGlobalInstall()) {
      const updateSpinner = ora("Updating global CLI...").start();
      try {
        execSync("npm install -g tutti-ai@latest", { stdio: "pipe" });
        updateSpinner.succeed("CLI updated to " + cliLatest);
      } catch {
        updateSpinner.fail("Failed to update global CLI");
        console.log(chalk.dim("  Run manually: npm install -g tutti-ai@latest"));
      }
    } else {
      console.log(chalk.dim("  Global: npm install -g tutti-ai@latest"));
    }
  } else {
    console.log(chalk.green("  CLI is up to date") + chalk.dim(" (" + cliCurrent + ")"));
  }

  // 2. Check local project packages
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    console.log();
    console.log(chalk.dim("  No package.json found — skipping project dependency check."));
    console.log();
    return;
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    console.log(chalk.dim("  Could not read package.json"));
    return;
  }

  const allDeps = new Map<string, string>();
  if (pkg.dependencies) {
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      allDeps.set(name, version);
    }
  }
  if (pkg.devDependencies) {
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      allDeps.set(name, version);
    }
  }

  const installed = TUTTI_PACKAGES.filter((p) => allDeps.has(p));
  if (installed.length === 0) {
    console.log();
    console.log(chalk.dim("  No @tuttiai packages found in this project."));
    console.log();
    return;
  }

  console.log();
  console.log("  " + chalk.bold("Project packages:"));

  const toUpdate: string[] = [];
  for (const name of installed) {
    const current = allDeps.get(name) ?? "?";
    const latest = getLatestVersion(name);
    if (!latest) {
      console.log("  " + chalk.dim(name) + " " + current + chalk.dim(" (could not check)"));
      continue;
    }
    const cleanCurrent = current.replace(/^[\^~]/, "");
    if (cleanCurrent === latest) {
      console.log("  " + chalk.green("✔") + " " + name + " " + chalk.dim(latest));
    } else {
      console.log(
        "  " + chalk.yellow("↑") + " " + name + " " +
          chalk.dim(cleanCurrent) + " → " + chalk.green(latest),
      );
      toUpdate.push(name + "@latest");
    }
  }

  if (toUpdate.length === 0) {
    console.log();
    console.log(chalk.green("  All packages are up to date."));
    console.log();
    return;
  }

  console.log();
  const pm = detectPackageManager();
  const installCmd = pm === "yarn"
    ? "yarn add " + toUpdate.join(" ")
    : pm === "pnpm"
      ? "pnpm add " + toUpdate.join(" ")
      : "npm install " + toUpdate.join(" ");

  const updateSpinner = ora("Updating " + toUpdate.length + " package(s)...").start();
  try {
    execSync(installCmd, { cwd: process.cwd(), stdio: "pipe" });
    updateSpinner.succeed("Updated " + toUpdate.length + " package(s)");
  } catch {
    updateSpinner.fail("Update failed");
    console.log(chalk.dim("  Run manually: " + installCmd));
  }
  console.log();
}
