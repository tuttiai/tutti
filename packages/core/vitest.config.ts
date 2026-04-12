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
        // Provider implementations require real API keys — tested via integration/E2E
        "src/providers/**",
        // Database store requires a running PostgreSQL instance
        "src/memory/postgres.ts",
        // Semantic memory interface (no implementation code)
        "src/memory/semantic.ts",
        // OTel SDK setup requires a running collector
        "src/telemetry-setup.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
        statements: 85,
      },
    },
  },
});
