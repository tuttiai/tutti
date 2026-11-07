import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import ora from "ora";
import { logger } from "../logger.js";
import { parseRegistryBody } from "../registry-response.js";
import type { RegistryEntry, RegistryResponse } from "../registry-response.js";

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
    description: "Interact with GitHub repos, issues, PRs, branches, commits, and code search",
    tags: ["github", "git", "code", "issues", "pull-requests", "api"],
    official: true,
    tools: 23,
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
    package: "@tuttiai/postgres",
    description: "Query and inspect a PostgreSQL database (read-only by default; writes via destructive 'execute' tool)",
    tags: ["postgres", "postgresql", "database", "sql", "analytics"],
    official: true,
    tools: 8,
  },
];

async function readRegistry(): Promise<string | undefined> {
  try {
    const res = await fetch(REGISTRY_URL);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } catch {
    logger.debug("Registry unreachable, using built-in voice list");
    return undefined;
  }
}

function toVoices(data: RegistryResponse): VoiceEntry[] {
  // The registry's numeric tools_count wins; otherwise the built-in count, then 0.
  const toVoice = ({ tools_count, ...entry }: RegistryEntry, official: boolean): VoiceEntry => {
    const builtin = BUILTIN_VOICES.find((v) => v.name === entry.name)?.tools ?? 0;
    return { ...entry, official, tools: typeof tools_count === "number" ? tools_count : builtin };
  };
  return [...data.official.map((e) => toVoice(e, true)), ...data.community.map((e) => toVoice(e, false))];
}

/** Fetch the voice registry, falling back to the built-in list when it is unreachable, empty or invalid. */
export async function fetchRegistry(): Promise<VoiceEntry[]> {
  const body = await readRegistry();
  if (body === undefined) return BUILTIN_VOICES;
  const parsed = parseRegistryBody(body);
  if (!parsed.success) {
    logger.warn({ reason: parsed.error }, "Voice registry response is invalid; using the built-in voice list");
    return BUILTIN_VOICES;
  }
  const voices = toVoices(parsed.data);
  if (voices.length === 0) logger.debug("Registry is empty, using built-in voice list");
  return voices.length > 0 ? voices : BUILTIN_VOICES;
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

  const installCmd = voice.official
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
