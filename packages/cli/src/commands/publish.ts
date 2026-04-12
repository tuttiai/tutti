import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";
import Enquirer from "enquirer";
import { createLogger, SecretsManager } from "@tuttiai/core";

const { prompt } = Enquirer;
const logger = createLogger("tutti-cli");

interface PkgJson {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  exports?: unknown;
}

function readPkg(dir: string): PkgJson | undefined {
  const p = resolve(dir, "package.json");
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf-8")) as PkgJson;
}

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf-8" });
}

function fail(msg: string): never {
  console.error(chalk.red("  " + msg));
  process.exit(1);
}

const ok = (msg: string) => console.log(chalk.green("  ✔ " + msg));

export async function publishCommand(opts: { dryRun?: boolean }): Promise<void> {
  const cwd = process.cwd();
  const pkg = readPkg(cwd);

  console.log();
  console.log(chalk.bold("  Tutti Voice Publisher"));
  console.log();

  // ── Step 1: Pre-flight checks ──

  const spinner = ora("Running pre-flight checks...").start();

  // 1a. Must be a voice directory
  if (!pkg) fail("No package.json found in the current directory.");
  if (!existsSync(resolve(cwd, "src/index.ts"))) fail("No src/index.ts found — are you inside a voice directory?");

  // 1b. Required fields
  const missing: string[] = [];
  if (!pkg.name) missing.push("name");
  if (!pkg.version) missing.push("version");
  if (!pkg.description) missing.push("description");
  if (!pkg.license) missing.push("license");
  if (!pkg.exports) missing.push("exports");
  if (missing.length > 0) fail("package.json is missing: " + missing.join(", "));

  const name = pkg.name!;
  const version = pkg.version!;

  // 1c. Name convention
  const validName = name.startsWith("@tuttiai/") || name.startsWith("tutti");
  if (!validName) fail("Package name must start with @tuttiai/ or tutti — got: " + name);

  // 1d. Check required_permissions is declared in source
  const src = readFileSync(resolve(cwd, "src/index.ts"), "utf-8");
  if (!src.includes("required_permissions")) {
    fail("Voice class must declare required_permissions in src/index.ts");
  }

  spinner.succeed("Pre-flight checks passed");

  // 1e. Build
  const buildSpinner = ora("Building...").start();
  try {
    run("npm run build", cwd);
    buildSpinner.succeed("Build succeeded");
  } catch (err) {
    buildSpinner.fail("Build failed");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.dim("  " + msg.split("\n").slice(0, 5).join("\n  ")));
    process.exit(1);
  }

  // 1f. Tests
  const testSpinner = ora("Running tests...").start();
  try {
    run("npx vitest run", cwd);
    testSpinner.succeed("Tests passed");
  } catch {
    testSpinner.fail("Tests failed");
    process.exit(1);
  }

  // 1g. Audit
  const auditSpinner = ora("Checking vulnerabilities...").start();
  try {
    run("npm audit --audit-level=high", cwd);
    auditSpinner.succeed("No high/critical vulnerabilities");
  } catch {
    auditSpinner.stopAndPersist({ symbol: chalk.yellow("⚠"), text: "Vulnerabilities found (npm audit)" });
  }

  // ── Step 2: Dry run ──

  console.log();
  const drySpinner = ora("Packing (dry run)...").start();
  let packOutput: string;
  try {
    packOutput = run("npm pack --dry-run 2>&1", cwd);
    drySpinner.succeed("Pack dry-run complete");
  } catch (err) {
    drySpinner.fail("Pack dry-run failed");
    const msg = err instanceof Error ? err.message : String(err);
    console.error(chalk.dim("  " + msg));
    process.exit(1);
  }

  // Show files from the pack output
  const fileLines = packOutput
    .split("\n")
    .filter((l) => l.includes("npm notice") && /\d+(\.\d+)?\s*[kM]?B\s/.test(l))
    .map((l) => l.replace(/npm notice\s*/, ""));

  if (fileLines.length > 0) {
    console.log(chalk.dim("  Files:"));
    for (const line of fileLines) {
      console.log(chalk.dim("    " + line.trim()));
    }
  }

  // Show totals
  const sizeLine = packOutput.split("\n").find((l) => l.includes("package size"));
  const totalLine = packOutput.split("\n").find((l) => l.includes("total files"));
  if (sizeLine) console.log(chalk.dim("  " + sizeLine.replace(/npm notice\s*/, "").trim()));
  if (totalLine) console.log(chalk.dim("  " + totalLine.replace(/npm notice\s*/, "").trim()));

  if (opts.dryRun) {
    console.log();
    ok("Dry run complete — no packages were published");
    console.log(chalk.dim("  Run without --dry-run to publish for real."));
    console.log();
    return;
  }

  // Prompt for confirmation
  console.log();
  const { confirm } = await prompt<{ confirm: boolean }>({
    type: "confirm",
    name: "confirm",
    message: "Publish " + chalk.cyan(name + "@" + version) + "?",
  });

  if (!confirm) {
    console.log(chalk.dim("  Cancelled."));
    return;
  }

  // ── Step 3: Publish ──

  const pubSpinner = ora("Publishing to npm...").start();
  try {
    run("npm publish --access public", cwd);
    pubSpinner.succeed("Published " + chalk.cyan(name + "@" + version));
  } catch (err) {
    pubSpinner.fail("Publish failed");
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "npm publish failed");
    process.exit(1);
  }

  // ── Step 4: Open PR to voice registry ──

  const ghToken = SecretsManager.optional("GITHUB_TOKEN");
  let prUrl: string | undefined;

  if (ghToken) {
    const prSpinner = ora("Opening PR to voice registry...").start();
    try {
      prUrl = await openRegistryPR(name, version, pkg.description ?? "", ghToken);
      prSpinner.succeed("PR opened: " + prUrl);
    } catch (err) {
      prSpinner.fail("Failed to open PR");
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "Registry PR failed");
    }
  } else {
    console.log();
    console.log(chalk.dim("  To list in the Repertoire, set GITHUB_TOKEN and re-run"));
    console.log(chalk.dim("  Or open a PR manually: github.com/tuttiai/voices"));
  }

  // ── Step 5: Summary ──

  console.log();
  ok(name + "@" + version + " published to npm");
  if (prUrl) ok("PR opened to tuttiai/voices");
  const shortName = name.replace("@tuttiai/", "").replace(/^tutti-?/, "");
  ok("Install: tutti-ai add " + shortName);
  ok("View: https://www.npmjs.com/package/" + name);
  console.log();
}

async function openRegistryPR(
  packageName: string,
  version: string,
  description: string,
  token: string,
): Promise<string> {
  const owner = "tuttiai";
  const repo = "voices";
  const branch = "add-" + packageName.replace(/[@/]/g, "-").replace(/^-/, "");
  const shortName = packageName.replace("@tuttiai/", "").replace(/^tutti-?/, "");
  const isOfficial = packageName.startsWith("@tuttiai/");

  // 1. Get current voices.json content and SHA
  const fileRes = await fetch(
    "https://api.github.com/repos/" + owner + "/" + repo + "/contents/voices.json",
    { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json" } },
  );
  if (!fileRes.ok) throw new Error("Failed to fetch voices.json: " + fileRes.status);
  const fileData = (await fileRes.json()) as { content: string; sha: string };

  interface RegistryVoice { name: string; package: string; description: string; version: string; author: string; tags: string[]; repo?: string }
  interface Registry { official: RegistryVoice[]; community: RegistryVoice[] }

  const registry = JSON.parse(Buffer.from(fileData.content, "base64").toString("utf-8")) as Registry;

  // 2. Add the new voice entry
  const section: keyof Registry = isOfficial ? "official" : "community";
  const entry: RegistryVoice = {
    name: shortName,
    package: packageName,
    description,
    repo: "https://github.com/tuttiai/tutti/tree/main/voices/" + shortName,
    version,
    author: isOfficial ? "tuttiai" : packageName.split("/")[0]?.replace("@", "") ?? "community",
    tags: [shortName],
  };

  if (!registry[section]) registry[section] = [];
  const exists = registry[section].some((v) => v.package === packageName);
  if (exists) {
    const idx = registry[section].findIndex((v) => v.package === packageName);
    registry[section][idx] = { ...registry[section][idx], ...entry };
  } else {
    registry[section].push(entry);
  }

  const updatedContent = Buffer.from(JSON.stringify(registry, null, 2) + "\n").toString("base64");

  // 3. Get default branch SHA
  const mainRes = await fetch(
    "https://api.github.com/repos/" + owner + "/" + repo + "/git/ref/heads/main",
    { headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json" } },
  );
  if (!mainRes.ok) throw new Error("Failed to get main ref: " + mainRes.status);
  const mainData = (await mainRes.json()) as { object: { sha: string } };

  // 4. Create branch
  await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/git/refs", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ ref: "refs/heads/" + branch, sha: mainData.object.sha }),
  });

  // 5. Update voices.json on the new branch
  await fetch(
    "https://api.github.com/repos/" + owner + "/" + repo + "/contents/voices.json",
    {
      method: "PUT",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "feat: add " + packageName + " to the Repertoire",
        content: updatedContent,
        sha: fileData.sha,
        branch,
      }),
    },
  );

  // 6. Create PR
  const prRes = await fetch("https://api.github.com/repos/" + owner + "/" + repo + "/pulls", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "feat: add " + packageName + " to the Repertoire",
      head: branch,
      base: "main",
      body: "## New voice: " + packageName + "@" + version + "\n\n" + description + "\n\nPublished via `tutti-ai publish`.",
    }),
  });

  if (!prRes.ok) {
    const err = await prRes.text();
    throw new Error("Failed to create PR: " + prRes.status + " " + err);
  }

  const prData = (await prRes.json()) as { html_url: string };
  return prData.html_url;
}
