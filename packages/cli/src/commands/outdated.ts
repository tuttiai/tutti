/**
 * `tutti-ai outdated` — check installed @tuttiai/* packages and voices
 * against the npm registry and show which ones have updates available.
 *
 * Does NOT install anything — just reports. Use `tutti-ai update` to
 * actually pull the latest versions.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";

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

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

export function outdatedCommand(): void {
  const pkgPath = resolve(process.cwd(), "package.json");
  if (!existsSync(pkgPath)) {
    console.error(chalk.red("No package.json found in the current directory."));
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as typeof pkg;
  } catch {
    console.error(chalk.red("Could not parse package.json"));
    process.exit(1);
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

  // Filter to @tuttiai/* packages only
  const tuttiDeps = [...allDeps.entries()].filter(([name]) => name.startsWith("@tuttiai/"));
  if (tuttiDeps.length === 0) {
    console.log(chalk.dim("No @tuttiai packages found in this project."));
    return;
  }

  const spinner = ora("Checking npm registry...").start();

  const results: Array<{ name: string; current: string; latest: string; outdated: boolean }> = [];
  for (const [name, version] of tuttiDeps) {
    const latest = getLatestVersion(name);
    const current = version.replace(/^[\^~]/, "");
    results.push({
      name,
      current,
      latest: latest ?? "?",
      outdated: latest !== null && current !== latest,
    });
  }

  spinner.stop();

  console.log();
  console.log(
    chalk.dim(
      "  " + pad("PACKAGE", 28) + pad("CURRENT", 12) + pad("LATEST", 12) + "STATUS",
    ),
  );
  console.log(chalk.dim("  " + "─".repeat(64)));

  let outdatedCount = 0;
  for (const r of results) {
    const status = r.outdated
      ? chalk.yellow("update available")
      : chalk.green("up to date");
    if (r.outdated) outdatedCount++;

    console.log(
      "  " +
        pad(r.name, 28) +
        pad(r.current, 12) +
        pad(r.latest, 12) +
        status,
    );
  }

  console.log();
  if (outdatedCount > 0) {
    console.log(
      chalk.yellow("  " + outdatedCount + " package(s) can be updated.") +
        chalk.dim(" Run: tutti-ai update"),
    );
  } else {
    console.log(chalk.green("  All packages are up to date."));
  }
  console.log();
}
