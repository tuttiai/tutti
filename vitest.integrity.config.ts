import { defineConfig } from "vitest/config";

// The source-integrity checker lives at the repository root, outside every workspace, so its
// tests run from here rather than through turbo's per-package `test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integrity/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      // The entries only wire the real file system, git and process streams to run(); left out.
      include: ["scripts/integrity/**/*.ts"],
      thresholds: { statements: 90, branches: 90, functions: 100, lines: 90 },
    },
  },
});
