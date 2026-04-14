import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "dist/**",
        "**/*.d.ts",
        // Interactive commands requiring REPL, spinners, or network — tested via E2E
        "src/commands/run.ts",
        "src/commands/studio.ts",
        "src/commands/check.ts",
        "src/commands/publish.ts",
        "src/commands/search.ts",
        "src/commands/add.ts",
        "src/commands/eval.ts",
        "src/commands/resume.ts",
        "src/commands/serve.ts",
        "src/commands/replay.ts",
        "src/commands/schedule.ts",
        "src/commands/schedules.ts",
        "src/commands/update.ts",
        "src/commands/outdated.ts",
        "src/commands/info.ts",
        "src/commands/upgrade.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 60,
        branches: 55,
        statements: 70,
      },
    },
  },
});
