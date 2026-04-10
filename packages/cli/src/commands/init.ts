import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import Enquirer from "enquirer";

const { prompt } = Enquirer;

export async function initCommand(projectName?: string): Promise<void> {
  if (!projectName) {
    const response = await prompt<{ projectName: string }>({
      type: "input",
      name: "projectName",
      message: "Project name?",
    });
    projectName = response.projectName;
  }

  if (!projectName) {
    console.error(chalk.red("Project name is required."));
    process.exit(1);
  }

  const dir = join(process.cwd(), projectName);

  if (existsSync(dir)) {
    console.error(chalk.red(`Directory already exists: ${projectName}/`));
    process.exit(1);
  }

  mkdirSync(dir, { recursive: true });

  const files: Record<string, string> = {
    "package.json": JSON.stringify(
      {
        name: projectName,
        version: "0.0.1",
        type: "module",
        scripts: {
          dev: "tsx watch tutti.score.ts",
          start: "tsx tutti.score.ts",
        },
        dependencies: {
          "@tuttiai/core": "*",
          "@tuttiai/types": "*",
        },
        devDependencies: {
          tsx: "^4.0.0",
          typescript: "^5.7.0",
        },
      },
      null,
      2,
    ),

    ".env.example": "ANTHROPIC_API_KEY=your_key_here\n",

    ".gitignore": "node_modules\ndist\n.env\n",

    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          esModuleInterop: true,
          skipLibCheck: true,
          outDir: "dist",
          rootDir: ".",
        },
        include: ["."],
      },
      null,
      2,
    ),

    "tutti.score.ts": `import { defineScore, AnthropicProvider } from "@tuttiai/core"

export default defineScore({
  provider: new AnthropicProvider(),
  default_model: "claude-sonnet-4-20250514",
  agents: {
    assistant: {
      name: "Assistant",
      system_prompt: "You are a helpful assistant.",
      voices: [],
    }
  }
})
`,

    "README.md": `# ${projectName}

A Tutti agent project. All agents. All together.

## Setup

\`\`\`bash
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
npm install
\`\`\`

## Run

\`\`\`bash
npm run dev
\`\`\`
`,
  };

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(dir, filename), content);
  }

  console.log();
  console.log(chalk.green(`  ✔ Created ${projectName}/`));
  console.log();
  console.log("  Next steps:");
  console.log(chalk.cyan(`    cd ${projectName}`));
  console.log(chalk.cyan("    cp .env.example .env"));
  console.log(chalk.cyan("    npm install"));
  console.log(chalk.cyan("    npm run dev"));
  console.log();
}
