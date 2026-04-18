import { createLogger } from "@tuttiai/core";

/**
 * Shared pino logger for the CLI. Command modules **must** import this
 * singleton rather than calling `createLogger()` directly.
 *
 * @remarks
 * tsup bundles every CLI command module into a single file, so every
 * `commands/*.ts` is eagerly imported at startup. Each `createLogger`
 * call in pino registers a `process.on("exit", ...)` listener via the
 * pino-pretty transport. With 18+ command modules calling it, the
 * listener count crosses Node's default max of 10 and the CLI emits a
 * `MaxListenersExceededWarning` on every invocation.
 *
 * Centralising through this singleton collapses that to one logger and
 * one exit listener — no warning, no per-command boilerplate.
 *
 * @example
 * ```ts
 * import { logger } from "../logger.js";
 * logger.info({ score }, "Loaded score");
 * ```
 */
export const logger = createLogger("tutti-cli");
