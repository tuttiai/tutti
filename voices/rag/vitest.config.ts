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
        // Test files colocated in src/ — should not count as source coverage
        "src/**/*.test.ts",
        // Type-only files (no runtime code)
        "src/types.ts",
        "src/stores/types.ts",
        "src/embeddings/types.ts",
        // Embedding providers require real API keys
        "src/embeddings/anthropic.ts",
        "src/embeddings/local.ts",
        // pgvector store requires a live PostgreSQL instance with the pgvector extension
        "src/stores/pgvector.ts",
        // Tool context wiring — requires full runtime; covered by integration tests
        "src/tool-context.ts",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
