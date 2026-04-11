import { config } from "dotenv";
config();

process.on("unhandledRejection", (reason) => {
  console.error("[tutti] Unhandled error:", reason);
  console.error("Report at github.com/tuttiai/tutti/issues");
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("[tutti] Fatal error:", err.message);
  process.exit(1);
});

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { addCommand } from "./commands/add.js";
import { checkCommand } from "./commands/check.js";

const program = new Command();

program
  .name("tutti-ai")
  .description("Tutti — multi-agent orchestration. All agents. All together.")
  .version("0.4.0");

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

program.parse();
