import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Pass if no tests are found — MCP voice has minimal unit testable surface
    // (most behavior requires a running MCP server process)
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      // src/index.ts contains the full implementation for this voice, not just re-exports
      exclude: ["dist/**", "**/*.d.ts"],
      // No thresholds — MCP voice requires a real server process for meaningful tests
    },
  },
});
