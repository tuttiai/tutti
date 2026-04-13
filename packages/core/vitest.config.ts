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
        // Checkpoint backends — same reasoning as memory/postgres.ts:
        // integration tests require a live Redis / Postgres and skip
        // in CI when TUTTI_REDIS_URL / TUTTI_PG_URL are unset.
        "src/checkpoint/redis.ts",
        "src/checkpoint/postgres.ts",
        // Checkpoint interface + types (no runtime code).
        "src/checkpoint/store.ts",
        "src/checkpoint/types.ts",
      ],
      thresholds: {
        lines: 85,
        functions: 84,
        branches: 75,
        statements: 85,
      },
    },
  },
});
