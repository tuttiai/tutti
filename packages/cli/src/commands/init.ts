import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import Enquirer from "enquirer";
import { TEMPLATES, getTemplate } from "../templates/index.js";
import type { Template } from "../templates/index.js";
import { logger } from "../logger.js";

const { prompt } = Enquirer;

export async function initCommand(projectName?: string, templateId?: string): Promise<void> {
  if (!projectName) {
    const response = await prompt<{ projectName: string }>({
      type: "input",
      name: "projectName",
      message: "Project name?",
    });
    projectName = response.projectName;
  }

  if (!projectName) {
    logger.error("Project name is required");
    process.exit(1);
  }

  const dir = join(process.cwd(), projectName);

  if (existsSync(dir)) {
    logger.error({ dir: `${projectName}/` }, "Directory already exists");
    process.exit(1);
  }

  // Resolve template
  let template: Template | undefined;
  if (templateId) {
    template = getTemplate(templateId);
    if (!template) {
      logger.error({ template: templateId }, "Unknown template");
      console.error(chalk.dim("  Available: " + TEMPLATES.map((t) => t.id).join(", ")));
      process.exit(1);
    }
  } else {
    // Interactive picker
    const response = await prompt<{ templateId: string }>({
      type: "select",
      name: "templateId",
      message: "Which template?",
      choices: TEMPLATES.map((t) => ({
        name: t.id,
        message: t.name + chalk.dim(" — " + t.description),
      })),
    });
    template = getTemplate(response.templateId);
    if (!template) template = TEMPLATES[0];
  }

  mkdirSync(dir, { recursive: true });

  const deps: Record<string, string> = {
    "@tuttiai/core": "*",
    "@tuttiai/types": "*",
    ...template.deps,
  };

  const envLines = [
    "ANTHROPIC_API_KEY=your_key_here",
    ...template.envVars,
    "",
    "# Log level: debug | info | warn | error (default: info)",
    "TUTTI_LOG_LEVEL=info",
    "",
    "# OpenTelemetry (optional)",
    "# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318",
    "# OTEL_SERVICE_NAME=tutti",
  ];

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
        dependencies: deps,
        devDependencies: {
          tsx: "^4.0.0",
          typescript: "^5.7.0",
        },
      },
      null,
      2,
    ),

    ".env.example": envLines.join("\n") + "\n",

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

    "tutti.score.ts": template.score,

    "README.md": `# ${projectName}

A Tutti agent project. All agents. All together.

**Template:** ${template.name} — ${template.description}

## Setup

\`\`\`bash
cp .env.example .env
# Add your API keys to .env
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
  console.log(chalk.green(`  ✔ Created ${projectName}/`) + chalk.dim(` (${template.name})`));
  console.log();
  console.log("  Next steps:");
  console.log(chalk.cyan(`    cd ${projectName}`));
  console.log(chalk.cyan("    cp .env.example .env"));
  console.log(chalk.cyan("    npm install"));
  console.log(chalk.cyan("    npm run dev"));
  console.log();
}

export function templatesCommand(): void {
  console.log();
  console.log(chalk.bold("  Available Templates"));
  console.log();
  for (const t of TEMPLATES) {
    console.log("  " + chalk.cyan(t.id.padEnd(18)) + t.description);
  }
  console.log();
  console.log(chalk.dim("  Use: tutti-ai init my-project --template " + TEMPLATES[0].id));
  console.log();
}
