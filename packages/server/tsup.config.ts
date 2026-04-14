import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
  },
  {
    entry: ["src/start.ts"],
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
  },
]);
