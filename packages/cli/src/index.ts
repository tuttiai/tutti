import { config } from "dotenv";
config();

import { createLogger } from "@tuttiai/core";
const logger = createLogger("tutti-cli");

process.on("unhandledRejection", (reason) => {
  logger.error({ error: reason instanceof Error ? reason.message : String(reason) }, "Unhandled rejection");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  logger.error({ error: err.message }, "Fatal error");
  process.exit(1);
});

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { addCommand } from "./commands/add.js";
import { checkCommand } from "./commands/check.js";
import { studioCommand } from "./commands/studio.js";
import { searchCommand, voicesCommand } from "./commands/search.js";
import { publishCommand } from "./commands/publish.js";

const program = new Command();

program
  .name("tutti-ai")
  .description("Tutti — multi-agent orchestration. All agents. All together.")
  .version("0.8.0");

program
  .command("init [project-name]")
  .description("Create a new Tutti project")
  .action(async (projectName?: string) => {
    await initCommand(projectName);
  });

program
  .command("run [score]")
  .description("Run a Tutti score interactively")
  .action(async (score?: string) => {
    await runCommand(score);
  });

program
  .command("add <voice>")
  .description("Add a voice to your project")
  .action(async (voice: string) => {
    await addCommand(voice);
  });

program
  .command("check [score]")
  .description("Validate a score file without running it")
  .action(async (score?: string) => {
    await checkCommand(score);
  });

program
  .command("doctor [score]")
  .description("Alias for check — validate a score file")
  .action(async (score?: string) => {
    await checkCommand(score);
  });

program
  .command("studio [score]")
  .description("Launch Tutti Studio — local web UI for inspecting agent runs")
  .action(async (score?: string) => {
    await studioCommand(score);
  });

program
  .command("search <query>")
  .description("Search the voice registry for voices matching a query")
  .action(async (query: string) => {
    await searchCommand(query);
  });

program
  .command("voices")
  .description("List all available official voices and install status")
  .action(async () => {
    await voicesCommand();
  });

program
  .command("publish")
  .description("Publish the current voice to npm and the voice registry")
  .option("--dry-run", "Run all checks without publishing")
  .action(async (opts: { dryRun?: boolean }) => {
    await publishCommand(opts);
  });

program.parse();
