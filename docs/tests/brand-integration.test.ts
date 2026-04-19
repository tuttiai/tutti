import { describe, it, expect } from "vitest";
import { statSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const docsRoot = resolve(__dirname, "..");

function abs(relative: string): string {
  return resolve(docsRoot, relative);
}

function fileSize(relative: string): number {
  return statSync(abs(relative)).size;
}

function fileContents(relative: string): string {
  return readFileSync(abs(relative), "utf8");
}

describe("brand integration", () => {
  describe("public assets", () => {
    const rasterAssets = [
      "public/favicon.svg",
      "public/favicon-16.png",
      "public/favicon-32.png",
      "public/apple-touch-icon.png",
      "public/og-image.png",
    ];

    it.each(rasterAssets)("%s exists and is >200 bytes", (asset) => {
      expect(existsSync(abs(asset))).toBe(true);
      expect(fileSize(asset)).toBeGreaterThan(200);
    });
  });

  describe("source assets", () => {
    it("logo.svg exists", () => {
      expect(existsSync(abs("src/assets/logo.svg"))).toBe(true);
    });

    it("logo-dark.svg exists", () => {
      expect(existsSync(abs("src/assets/logo-dark.svg"))).toBe(true);
    });
  });

  describe("styles", () => {
    it("custom.css imports brand-tokens.css", () => {
      const css = fileContents("src/styles/custom.css");
      expect(css).toContain("@import './brand-tokens.css'");
    });

    it("brand-tokens.css defines the deep brand colour", () => {
      const css = fileContents("src/styles/brand-tokens.css");
      expect(css).toContain("--tutti-brand-deep: #0F6E56");
    });
  });

  describe("astro config", () => {
    it("keeps replacesTitle: false on the logo", () => {
      const cfg = fileContents("astro.config.mjs");
      expect(cfg).toContain("replacesTitle: false");
    });
  });
});
