import { config } from "dotenv";
config();

import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";
import { addCommand } from "./commands/add.js";

const program = new Command();

program
  .name("tutti-ai")
  .description("Tutti — multi-agent orchestration. All agents. All together.")
  .version("0.2.0");

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

program.parse();
