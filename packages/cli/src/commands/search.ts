import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { createLogger } from "@tuttiai/core";

const logger = createLogger("tutti-cli");

const REGISTRY_URL =
  "https://raw.githubusercontent.com/tuttiai/voices/main/voices.json";

interface VoiceEntry {
  name: string;
  package: string;
  description: string;
  tags: string[];
  official: boolean;
  tools: number;
}

// Built-in fallback when the remote registry is unreachable
const BUILTIN_VOICES: VoiceEntry[] = [
  {
    name: "filesystem",
    package: "@tuttiai/filesystem",
    description: "Read, write, search, and manage files and directories",
    tags: ["filesystem", "files", "io", "read", "write"],
    official: true,
    tools: 7,
  },
  {
    name: "github",
    package: "@tuttiai/github",
    description: "Interact with GitHub repos, issues, PRs, and code search",
    tags: ["github", "git", "code", "issues", "pull-requests", "api"],
    official: true,
    tools: 10,
  },
  {
    name: "playwright",
    package: "@tuttiai/playwright",
    description: "Control a browser like a human — navigate, click, type, screenshot",
    tags: ["browser", "playwright", "web", "qa", "testing", "automation", "scraping"],
    official: true,
    tools: 12,
  },
  {
    name: "postgres",
    package: "pg",
    description: "PostgreSQL session persistence and database access",
    tags: ["database", "postgres", "sql", "persistence", "sessions"],
    official: true,
    tools: 0,
  },
];

interface RegistryEntry {
  name: string;
  package: string;
  description: string;
  tags: string[];
}

async function fetchRegistry(): Promise<VoiceEntry[]> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = (await res.json()) as { official?: RegistryEntry[]; community?: RegistryEntry[] };

    const voices: VoiceEntry[] = [];
    for (const entry of data.official ?? []) {
      voices.push({ ...entry, official: true, tools: toolCount(entry.name) });
    }
    for (const entry of data.community ?? []) {
      voices.push({ ...entry, official: false, tools: 0 });
    }
    if (voices.length === 0) throw new Error("Empty registry");
    return voices;
  } catch {
    logger.debug("Registry unreachable, using built-in voice list");
    return BUILTIN_VOICES;
  }
}

function toolCount(name: string): number {
  const counts: Record<string, number> = { filesystem: 7, github: 10, playwright: 12 };
  return counts[name] ?? 0;
}

function matchesQuery(voice: VoiceEntry, query: string): boolean {
  const q = query.toLowerCase();
  if (voice.name.toLowerCase().includes(q)) return true;
  if (voice.description.toLowerCase().includes(q)) return true;
  if (voice.tags.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

function isInstalled(packageName: string): boolean {
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

function printVoice(voice: VoiceEntry, showInstallStatus: boolean): void {
  const badge = voice.official
    ? chalk.green(" [official]")
    : chalk.blue(" [community]");
  const installed = showInstallStatus && isInstalled(voice.package);
  const status = showInstallStatus
    ? installed
      ? chalk.green(" ✔ installed")
      : chalk.dim(" not installed")
    : "";

  console.log();
  console.log("  " + chalk.bold(voice.package) + badge + status);
  console.log("  " + voice.description);

  const installCmd = voice.official && voice.name !== "postgres"
    ? "tutti-ai add " + voice.name
    : "npm install " + voice.package;
  console.log("  " + chalk.dim("Install: ") + chalk.cyan(installCmd));

  if (voice.tags.length > 0) {
    console.log("  " + chalk.dim("Tags: ") + voice.tags.join(", "));
  }
}

export async function searchCommand(query: string): Promise<void> {
  const spinner = ora("Searching the Repertoire...").start();

  const voices = await fetchRegistry();
  const results = voices.filter((v) => matchesQuery(v, query));

  spinner.stop();

  if (results.length === 0) {
    console.log();
    console.log(chalk.yellow('  No voices found for "' + query + '"'));
    console.log();
    console.log(chalk.dim("  Browse all: https://tutti-ai.com/voices"));
    console.log(chalk.dim("  Build your own: tutti-ai create voice <name>"));
    console.log();
    return;
  }

  console.log();
  console.log(
    "  Found " +
      chalk.bold(String(results.length)) +
      " voice" +
      (results.length !== 1 ? "s" : "") +
      " matching " +
      chalk.cyan("'" + query + "'") +
      ":",
  );

  for (const voice of results) {
    printVoice(voice, false);
  }
  console.log();
}

export async function voicesCommand(): Promise<void> {
  const spinner = ora("Loading voices...").start();

  const voices = await fetchRegistry();
  const official = voices.filter((v) => v.official);

  spinner.stop();

  console.log();
  console.log("  " + chalk.bold("Official Tutti Voices"));
  console.log();

  for (const voice of official) {
    printVoice(voice, true);
  }

  const community = voices.filter((v) => !v.official);
  if (community.length > 0) {
    console.log();
    console.log("  " + chalk.bold("Community Voices"));
    for (const voice of community) {
      printVoice(voice, true);
    }
  }

  console.log();
  console.log(chalk.dim("  Search: tutti-ai search <query>"));
  console.log(chalk.dim("  Browse: https://tutti-ai.com/voices"));
  console.log();
}
