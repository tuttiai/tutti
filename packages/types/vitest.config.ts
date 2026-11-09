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
      // Only the modules with runtime code; the rest of the package is
      // type declarations, which v8 coverage cannot measure.
      include: ["src/cost-api.ts", "src/interrupts-api.ts"],
      exclude: ["dist/**", "**/*.d.ts"],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 80,
        statements: 90,
      },
    },
  },
});
