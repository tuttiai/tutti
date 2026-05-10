import { existsSync } from "node:fs";
import { resolve } from "node:path";
import chalk from "chalk";
import {
  TuttiRuntime,
  ScoreLoader,
} from "@tuttiai/core";
import type { ScoreConfig, InboxAdapterConfig } from "@tuttiai/types";
import {
  TuttiInbox,
  TelegramInboxAdapter,
  SlackInboxAdapter,
  DiscordInboxAdapter,
  EmailInboxAdapter,
  WhatsAppInboxAdapter,
} from "@tuttiai/inbox";
import type { InboxAdapter } from "@tuttiai/inbox";
import { logger } from "../logger.js";

/**
 * Build a runtime adapter instance from a score-defined adapter
 * config. Centralised so the union stays exhaustively checked — TS
 * will yell when a new platform is added to the discriminated union
 * but no case is added here.
 */
function buildAdapter(config: InboxAdapterConfig): InboxAdapter {
  switch (config.platform) {
    case "telegram": {
      const opts: { token?: string; polling?: boolean } = {};
      if (config.token !== undefined) opts.token = config.token;
      if (config.polling !== undefined) opts.polling = config.polling;
      return new TelegramInboxAdapter(opts);
    }
    case "slack": {
      const opts: { botToken?: string; appToken?: string } = {};
      if (config.botToken !== undefined) opts.botToken = config.botToken;
      if (config.appToken !== undefined) opts.appToken = config.appToken;
      return new SlackInboxAdapter(opts);
    }
    case "discord": {
      const opts: { token?: string } = {};
      if (config.token !== undefined) opts.token = config.token;
      return new DiscordInboxAdapter(opts);
    }
    case "email": {
      const opts: ConstructorParameters<typeof EmailInboxAdapter>[0] = {
        imap: config.imap,
        smtp: config.smtp,
        from: config.from,
      };
      if (config.maxBodyChars !== undefined) opts.maxBodyChars = config.maxBodyChars;
      if (config.inboxRedactRawText !== undefined) {
        opts.inboxRedactRawText = config.inboxRedactRawText;
      }
      return new EmailInboxAdapter(opts);
    }
    case "whatsapp": {
      const opts: ConstructorParameters<typeof WhatsAppInboxAdapter>[0] = {
        phoneNumberId: config.phoneNumberId,
      };
      if (config.port !== undefined) opts.port = config.port;
      if (config.host !== undefined) opts.host = config.host;
      if (config.graphApiVersion !== undefined) opts.graphApiVersion = config.graphApiVersion;
      if (config.bodyLimit !== undefined) opts.bodyLimit = config.bodyLimit;
      if (config.inboxRedactRawText !== undefined) {
        opts.inboxRedactRawText = config.inboxRedactRawText;
      }
      return new WhatsAppInboxAdapter(opts);
    }
    default: {
      // Exhaustiveness guard.
      const _exhaustive: never = config;
      throw new Error(
        `Unknown inbox adapter platform: ${JSON.stringify(_exhaustive)}. Supported: telegram, slack, discord, email, whatsapp.`,
      );
    }
  }
}

/**
 * `tutti-ai inbox start [score]` — boot a {@link TuttiInbox} with the
 * adapters declared in the score's `inbox` block. Streams a brief
 * status line per connected adapter, then runs until SIGINT/SIGTERM,
 * at which point every adapter is stopped in parallel.
 */
export async function inboxStartCommand(scorePath?: string): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");
  if (!existsSync(file)) {
    logger.error({ file }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score: ScoreConfig;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to load score",
    );
    process.exit(1);
  }

  if (!score.inbox) {
    console.error(
      chalk.red(
        "Score has no `inbox` block. Add one to declare which agent receives inbound messages and from which platforms.",
      ),
    );
    process.exit(1);
  }

  const inboxConfig = score.inbox;
  const adapters = inboxConfig.adapters.map(buildAdapter);

  const runtime = new TuttiRuntime(score);

  const inbox = new TuttiInbox(runtime, {
    agent: inboxConfig.agent,
    adapters,
    ...(inboxConfig.allowedUsers !== undefined
      ? { allowedUsers: inboxConfig.allowedUsers }
      : {}),
    ...(inboxConfig.rateLimit !== undefined ? { rateLimit: inboxConfig.rateLimit } : {}),
    ...(inboxConfig.maxQueuePerChat !== undefined
      ? { maxQueuePerChat: inboxConfig.maxQueuePerChat }
      : {}),
  });

  // Print one status line per adapter as it connects so an operator
  // running `inbox start` immediately sees what's live.
  runtime.events.on("inbox:message_received", (e) => {
    logger.info(
      { platform: e.platform, chat: e.platform_chat_id },
      "inbox: dispatching message",
    );
  });
  runtime.events.on("inbox:message_blocked", (e) => {
    logger.warn(
      { platform: e.platform, reason: e.reason, chat: e.platform_chat_id },
      "inbox: message blocked",
    );
  });
  runtime.events.on("inbox:error", (e) => {
    logger.error(
      { platform: e.platform, stage: e.stage, error: e.error_message },
      "inbox: error (non-fatal)",
    );
  });

  try {
    await inbox.start();
  } catch (err) {
    logger.error(
      { error: err instanceof Error ? err.message : String(err) },
      "Failed to start inbox",
    );
    process.exit(1);
  }

  for (const adapter of adapters) {
    console.log(
      chalk.green(`[inbox] adapter connected: ${chalk.bold(adapter.platform)}`),
    );
  }
  console.log(
    chalk.dim(
      `[inbox] agent=${inboxConfig.agent}, adapters=${adapters.map((a) => a.platform).join(", ")}. Press Ctrl+C to stop.`,
    ),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(chalk.dim(`\n[inbox] received ${signal}, stopping adapters…`));
    try {
      await inbox.stop();
    } catch (err) {
      logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        "Inbox stop failed",
      );
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
