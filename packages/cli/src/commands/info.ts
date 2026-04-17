/**
 * `tutti-ai info` — show project information: score, agents, voices, versions.
 *
 * Reads the score file and package.json from the current directory and
 * prints a structured overview of the project configuration.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import { ScoreLoader } from "@tuttiai/core";
import { logger } from "../logger.js";

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

/**
 * Resolve the installed version of a dependency by reading its
 * `node_modules/<name>/package.json`. Falls back to the spec string
 * (e.g. `*`, `^1.0.0`, `workspace:*`) when the package isn't installed
 * or the file can't be read.
 *
 * @param name - Dependency package name (e.g. `@tuttiai/core`).
 * @param spec - Version range from the project's `package.json`.
 * @param cwd - Project root to search from. Defaults to `process.cwd()`.
 */
export function resolveInstalledVersion(
  name: string,
  spec: string,
  cwd: string = process.cwd(),
): string {
  try {
    const pkgPath = resolve(cwd, "node_modules", name, "package.json");
    if (!existsSync(pkgPath)) return spec;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    return pkg.version ?? spec;
  } catch {
    return spec;
  }
}

export async function infoCommand(scorePath?: string): Promise<void> {
  // Project info from package.json
  const pkgPath = resolve(process.cwd(), "package.json");
  let projectName = "(unknown)";
  let projectVersion = "(unknown)";
  const installedDeps = new Map<string, string>();

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name?: string;
        version?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      projectName = pkg.name ?? "(unnamed)";
      projectVersion = pkg.version ?? "0.0.0";
      if (pkg.dependencies) {
        for (const [name, version] of Object.entries(pkg.dependencies)) {
          installedDeps.set(name, version);
        }
      }
      if (pkg.devDependencies) {
        for (const [name, version] of Object.entries(pkg.devDependencies)) {
          installedDeps.set(name, version);
        }
      }
    } catch {
      // ignore
    }
  }

  console.log();
  console.log(chalk.cyan.bold("  Tutti Project Info"));
  console.log();
  console.log("  " + chalk.dim("Project:") + "  " + chalk.bold(projectName) + " " + chalk.dim(projectVersion));

  // Installed @tuttiai/* packages
  const tuttiPkgs = [...installedDeps.entries()].filter(([name]) => name.startsWith("@tuttiai/"));
  if (tuttiPkgs.length > 0) {
    console.log();
    console.log("  " + chalk.bold("Packages:"));
    for (const [name, version] of tuttiPkgs) {
      const resolved = resolveInstalledVersion(name, version);
      console.log("    " + pad(name, 28) + chalk.dim(resolved));
    }
  }

  // Score file info
  const scoreFile = resolve(scorePath ?? "./tutti.score.ts");
  if (!existsSync(scoreFile)) {
    console.log();
    console.log(chalk.dim("  No score file found at " + scoreFile));
    console.log(chalk.dim('  Run "tutti-ai init" to create a new project.'));
    console.log();
    return;
  }

  let score;
  try {
    score = await ScoreLoader.load(scoreFile);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    console.log(chalk.dim("  Score file found but failed to load."));
    console.log();
    return;
  }

  console.log("  " + chalk.dim("Score:") + "    " + (score.name ?? scoreFile));

  // Agents
  const agentEntries = Object.entries(score.agents);
  console.log();
  console.log("  " + chalk.bold("Agents:") + chalk.dim(" (" + agentEntries.length + ")"));
  for (const [id, agent] of agentEntries) {
    const voiceNames = agent.voices.map((v) => v.name).join(", ") || "none";
    const model = agent.model ?? score.default_model ?? "(default)";
    const flags: string[] = [];
    if (agent.streaming) flags.push("streaming");
    if (agent.allow_human_input) flags.push("hitl");
    if (agent.durable) flags.push("durable");
    if (agent.schedule) flags.push("scheduled");
    if (agent.outputSchema) flags.push("structured");
    if (agent.beforeRun ?? agent.afterRun) flags.push("guardrails");

    console.log();
    console.log("    " + chalk.bold(id) + chalk.dim(" (" + agent.name + ")"));
    console.log("      " + chalk.dim("Model:  ") + model);
    console.log("      " + chalk.dim("Voices: ") + voiceNames);
    if (flags.length > 0) {
      console.log("      " + chalk.dim("Flags:  ") + flags.join(", "));
    }
    if (agent.schedule) {
      const sched = agent.schedule;
      const trigger = sched.cron ?? sched.every ?? sched.at ?? "?";
      console.log("      " + chalk.dim("Schedule: ") + trigger);
    }
  }

  // Entry point
  if (score.entry) {
    const entry = typeof score.entry === "string" ? score.entry : "parallel";
    console.log();
    console.log("  " + chalk.dim("Entry:") + "    " + entry);
  }

  console.log();
}
