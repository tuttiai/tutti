import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { runCommand } from "./commands/run.js";

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

program.parse();
