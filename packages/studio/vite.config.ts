import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The studio is mounted at /studio/* by the Tutti server. Vite's `base`
// must match so generated asset URLs (script/link hrefs in index.html)
// resolve correctly when the SPA is served behind that prefix.
export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
});
