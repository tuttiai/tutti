import { defineConfig } from "vitest/config";

// The docs code-sample checker lives under docs/, outside every workspace, so its tests run from
// the root rather than through turbo's per-package `test` or the docs site's own vitest.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/docs-samples/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      // The entry only wires the real file system, TypeScript and process streams to run(); left out.
      include: ["docs/scripts/samples/**/*.ts"],
      thresholds: { statements: 90, branches: 90, functions: 100, lines: 90 },
    },
  },
});
