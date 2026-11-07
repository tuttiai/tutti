import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScoreConfig } from "@tuttiai/types";

const { storeUrls } = vi.hoisted(() => {
  const urls: string[] = [];
  return { storeUrls: urls };
});

vi.mock("../src/memory/postgres.js", () => ({
  PostgresSessionStore: class {
    constructor(url: string) {
      storeUrls.push(url);
    }
  },
}));

import { TuttiRuntime } from "../src/runtime.js";
import { ScoreValidationError } from "../src/errors.js";
import { createSingleResponseProvider } from "./helpers/mock-provider.js";

/** Obviously fake credentials: never a real host, user or password. */
const FAKE_ENV_URL = "postgres://u:p@db.invalid/env";
const FAKE_SCORE_URL = "postgres://u:p@db.invalid/score";

const MISSING_URL_MESSAGE =
  "PostgreSQL session store requires a connection URL.\n" +
  "Set memory.url in your score, or DATABASE_URL in your .env file.";

function postgresScore(url?: string): ScoreConfig {
  return {
    name: "database-url-test",
    provider: createSingleResponseProvider(),
    agents: {
      assistant: { name: "assistant", model: "test-model", system_prompt: "Hi.", voices: [] },
    },
    memory: url === undefined ? { provider: "postgres" } : { provider: "postgres", url },
  };
}

function constructionError(score: ScoreConfig): unknown {
  try {
    new TuttiRuntime(score);
  } catch (err: unknown) {
    return err;
  }
  return undefined;
}

describe("TuttiRuntime DATABASE_URL read", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    storeUrls.length = 0;
  });

  it("gives the store DATABASE_URL when the score has no url", () => {
    vi.stubEnv("DATABASE_URL", FAKE_ENV_URL);
    new TuttiRuntime(postgresScore());
    expect(storeUrls).toEqual([FAKE_ENV_URL]);
  });

  it("prefers memory.url over DATABASE_URL", () => {
    vi.stubEnv("DATABASE_URL", FAKE_ENV_URL);
    new TuttiRuntime(postgresScore(FAKE_SCORE_URL));
    expect(storeUrls).toEqual([FAKE_SCORE_URL]);
  });

  it("uses memory.url when DATABASE_URL is unset", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    new TuttiRuntime(postgresScore(FAKE_SCORE_URL));
    expect(storeUrls).toEqual([FAKE_SCORE_URL]);
  });

  it("throws the unchanged message when DATABASE_URL is unset", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    const err = constructionError(postgresScore());
    expect(err).toBeInstanceOf(ScoreValidationError);
    expect(err instanceof ScoreValidationError && err.message).toBe(MISSING_URL_MESSAGE);
    expect(storeUrls).toEqual([]);
  });

  it("throws the unchanged message when DATABASE_URL is empty", () => {
    vi.stubEnv("DATABASE_URL", "");
    const err = constructionError(postgresScore());
    expect(err).toBeInstanceOf(ScoreValidationError);
    expect(err instanceof ScoreValidationError && err.message).toBe(MISSING_URL_MESSAGE);
    expect(storeUrls).toEqual([]);
  });

  it("never puts DATABASE_URL in the error when memory.url is empty", () => {
    vi.stubEnv("DATABASE_URL", FAKE_ENV_URL);
    const err = constructionError(postgresScore(""));
    expect(err).toBeInstanceOf(ScoreValidationError);
    expect(err instanceof ScoreValidationError && err.message).toBe(MISSING_URL_MESSAGE);
    expect(JSON.stringify(err)).not.toContain(FAKE_ENV_URL);
    expect(String(err)).not.toContain(FAKE_ENV_URL);
    expect(storeUrls).toEqual([]);
  });

  it("reads DATABASE_URL when the runtime is built, not at import", () => {
    vi.stubEnv("DATABASE_URL", FAKE_ENV_URL);
    new TuttiRuntime(postgresScore());
    vi.stubEnv("DATABASE_URL", FAKE_SCORE_URL);
    new TuttiRuntime(postgresScore());
    expect(storeUrls).toEqual([FAKE_ENV_URL, FAKE_SCORE_URL]);
  });
});
