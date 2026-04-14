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
        // Octokit client instantiation depends on real GitHub auth
        "src/client.ts",
        "src/logger.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        // Most uncovered branches are Octokit error-handling paths that
        // require a live GitHub API — 50% reflects the realistic unit-test
        // coverage floor for mock-based testing.
        branches: 50,
        statements: 80,
      },
    },
  },
});
