/**
 * Shared pino logger for the CLI.
 *
 * Every command module imports this singleton rather than calling
 * `createLogger()` directly. This matters because each `createLogger`
 * call in pino registers a `process.on("exit", ...)` listener via the
 * pino-pretty transport. With 18+ command modules — all eagerly
 * imported at startup because tsup bundles the CLI into one file — the
 * listener count exceeds Node's default max of 10 and emits a
 * `MaxListenersExceededWarning`.
 *
 * One logger, one exit listener, no warning.
 */

import { createLogger } from "@tuttiai/core";

export const logger = createLogger("tutti-cli");
