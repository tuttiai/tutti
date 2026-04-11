import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { ScoreLoader } from "../src/score-loader.js";

const TMP_DIR = resolve(import.meta.dirname ?? __dirname, ".tmp-score-loader");

function writeTmpFile(name: string, content: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = resolve(TMP_DIR, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

describe("ScoreLoader", () => {
  // Cleanup after all tests
  afterAll(() => {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("loads a valid score file with default export", async () => {
    const path = writeTmpFile(
      "valid.mjs",
      `export default {
        provider: { chat: async () => ({}) },
        agents: {
          bot: {
            name: "bot",
            system_prompt: "hello",
            voices: [],
          },
        },
      };`,
    );

    const score = await ScoreLoader.load(path);
    expect(score.agents.bot.name).toBe("bot");
  });

  it("throws if the file has no default export", async () => {
    const path = writeTmpFile(
      "no-default.mjs",
      `export const foo = 42;`,
    );

    await expect(ScoreLoader.load(path)).rejects.toThrow(
      "has no default export",
    );
  });

  it("throws a Zod validation error for an invalid score", async () => {
    const path = writeTmpFile(
      "invalid.mjs",
      `export default { agents: {} };`,
    );

    await expect(ScoreLoader.load(path)).rejects.toThrow(
      "Invalid score file",
    );
  });

  it("throws for a nonexistent file", async () => {
    await expect(
      ScoreLoader.load("/tmp/does-not-exist-tutti-test.mjs"),
    ).rejects.toThrow();
  });
});
