import pino from "pino";
import { SecretsManager } from "./secrets.js";

export const createLogger = (name: string): pino.Logger =>
  pino({
    name,
    level: SecretsManager.optional("TUTTI_LOG_LEVEL", "info"),
    transport:
      SecretsManager.optional("NODE_ENV") === "production"
        ? undefined
        : {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss",
              ignore: "pid,hostname",
            },
          },
  });

export const logger = createLogger("tutti");
