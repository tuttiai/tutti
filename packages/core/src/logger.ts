import pino from "pino";

export const createLogger = (name: string) =>
  pino({
    name,
    level: process.env.TUTTI_LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV === "production"
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
