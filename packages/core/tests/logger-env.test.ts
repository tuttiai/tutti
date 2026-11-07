import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The subset of the pino options these tests read. */
interface CapturedOptions {
  name?: string;
  level?: string;
  transport?: unknown;
}

const { pinoMock } = vi.hoisted(() => ({
  pinoMock: vi.fn((options: CapturedOptions) => ({ options })),
}));

vi.mock("pino", () => ({ default: pinoMock }));

import { createLogger } from "../src/logger.js";

function optionsFor(env: Record<string, string | undefined>): CapturedOptions | undefined {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  createLogger("env-test");
  return pinoMock.mock.lastCall?.[0];
}

describe("createLogger environment reads", () => {
  beforeEach(() => {
    pinoMock.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("TUTTI_LOG_LEVEL", () => {
    it("uses the level when it is set", () => {
      expect(optionsFor({ TUTTI_LOG_LEVEL: "debug" })?.level).toBe("debug");
    });

    it("defaults to info when it is unset", () => {
      expect(optionsFor({ TUTTI_LOG_LEVEL: undefined })?.level).toBe("info");
    });

    it("passes an empty value through unchanged", () => {
      expect(optionsFor({ TUTTI_LOG_LEVEL: "" })?.level).toBe("");
    });
  });

  describe("NODE_ENV", () => {
    it("drops the pretty transport in production", () => {
      expect(optionsFor({ NODE_ENV: "production" })?.transport).toBeUndefined();
    });

    it("keeps the pretty transport when it is unset", () => {
      expect(optionsFor({ NODE_ENV: undefined })?.transport).toMatchObject({
        target: "pino-pretty",
      });
    });

    it("keeps the pretty transport when it is empty", () => {
      expect(optionsFor({ NODE_ENV: "" })?.transport).toMatchObject({
        target: "pino-pretty",
      });
    });

    it("treats only the exact value production as production", () => {
      expect(optionsFor({ NODE_ENV: "Production" })?.transport).toMatchObject({
        target: "pino-pretty",
      });
    });
  });

  it("reads the environment at call time, not at import", () => {
    vi.stubEnv("TUTTI_LOG_LEVEL", "warn");
    createLogger("late");
    vi.stubEnv("TUTTI_LOG_LEVEL", "error");
    createLogger("later");
    expect(pinoMock.mock.calls.map(([options]) => options.level)).toEqual(["warn", "error"]);
  });

  it("reads the environment for the shared logger when the module loads", async () => {
    vi.resetModules();
    vi.stubEnv("TUTTI_LOG_LEVEL", "trace");
    vi.stubEnv("NODE_ENV", "production");
    await import("../src/logger.js");
    expect(pinoMock.mock.calls[0]?.[0]).toEqual({
      name: "tutti",
      level: "trace",
      transport: undefined,
    });
  });
});
