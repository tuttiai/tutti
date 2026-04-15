/**
 * `tutti-ai memory <subcommand>` — manage per-user memories from the
 * shell.
 *
 * Connects to the same Postgres store the runtime uses (via TUTTI_PG_URL).
 * Falls back to the in-memory store when TUTTI_PG_URL is unset, but the
 * in-memory case is degenerate for CLI use (each invocation is a fresh
 * process with empty state) — we warn loudly so operators don't
 * misunderstand.
 */

import { writeFileSync } from "node:fs";
import chalk from "chalk";
import Enquirer from "enquirer";
import {
  MemoryUserMemoryStore,
  PostgresUserMemoryStore,
  SecretsManager,
  createLogger,
  type UserMemoryImportance,
  type UserMemoryStore,
} from "@tuttiai/core";

import {
  exportMemoriesCsv,
  exportMemoriesJson,
  renderMemoryAdded,
  renderMemoryCleared,
  renderMemoryDeleted,
  renderMemoryList,
  renderMemorySearch,
} from "./memory-render.js";

const logger = createLogger("tutti-cli");
const { prompt } = Enquirer;

/** Common opts every subcommand accepts. */
export interface MemoryOptions {
  user?: string;
}

/* ------------------------------------------------------------------ */
/*  Store resolution                                                   */
/* ------------------------------------------------------------------ */

function resolveStore(): UserMemoryStore & { close?: () => Promise<void> } {
  const pgUrl = SecretsManager.optional("TUTTI_PG_URL");
  if (pgUrl) {
    return new PostgresUserMemoryStore({ connection_string: pgUrl });
  }
  logger.warn(
    "TUTTI_PG_URL not set — using in-memory store " +
      "(memories are ephemeral; this command will appear to do nothing useful)",
  );
  return new MemoryUserMemoryStore();
}

async function closeStore(
  store: UserMemoryStore & { close?: () => Promise<void> },
): Promise<void> {
  if (typeof store.close === "function") {
    await store.close();
  }
}

function requireUser(opts: MemoryOptions): string {
  if (!opts.user || opts.user.trim() === "") {
    console.error(chalk.red("--user <user-id> is required"));
    process.exit(1);
  }
  return opts.user.trim();
}

function parseImportance(raw: string | undefined): UserMemoryImportance {
  if (raw === undefined) return 2;
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  if (raw === "3") return 3;
  console.error(chalk.red("--importance must be 1, 2, or 3"));
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/*  list                                                               */
/* ------------------------------------------------------------------ */

export async function memoryListCommand(opts: MemoryOptions): Promise<void> {
  const userId = requireUser(opts);
  const store = resolveStore();
  try {
    const memories = await store.list(userId);
    console.log(renderMemoryList(memories, userId));
  } finally {
    await closeStore(store);
  }
}

/* ------------------------------------------------------------------ */
/*  search                                                             */
/* ------------------------------------------------------------------ */

export async function memorySearchCommand(
  query: string,
  opts: MemoryOptions,
): Promise<void> {
  const userId = requireUser(opts);
  if (query.trim() === "") {
    console.error(chalk.red("Search query is required"));
    process.exit(1);
  }
  const store = resolveStore();
  try {
    const memories = await store.search(userId, query);
    console.log(renderMemorySearch(memories, userId, query));
  } finally {
    await closeStore(store);
  }
}

/* ------------------------------------------------------------------ */
/*  add                                                                */
/* ------------------------------------------------------------------ */

export async function memoryAddCommand(
  content: string,
  opts: MemoryOptions & { importance?: string },
): Promise<void> {
  const userId = requireUser(opts);
  if (content.trim() === "") {
    console.error(chalk.red("Memory content is required"));
    process.exit(1);
  }
  const importance = parseImportance(opts.importance);
  const store = resolveStore();
  try {
    const stored = await store.store(userId, content.trim(), {
      source: "explicit",
      importance,
    });
    console.log(renderMemoryAdded(stored));
  } finally {
    await closeStore(store);
  }
}

/* ------------------------------------------------------------------ */
/*  delete                                                             */
/* ------------------------------------------------------------------ */

export async function memoryDeleteCommand(
  memoryId: string,
  opts: MemoryOptions,
): Promise<void> {
  // --user is required for symmetry with the other subcommands and so
  // operators don't accidentally run a `delete` keyed only on a 36-char
  // UUID across whatever user happens to own it.
  requireUser(opts);
  const store = resolveStore();
  try {
    await store.delete(memoryId);
    console.log(renderMemoryDeleted(memoryId));
  } finally {
    await closeStore(store);
  }
}

/* ------------------------------------------------------------------ */
/*  clear                                                              */
/* ------------------------------------------------------------------ */

export async function memoryClearCommand(opts: MemoryOptions): Promise<void> {
  const userId = requireUser(opts);
  const store = resolveStore();
  try {
    const memories = await store.list(userId);
    if (memories.length === 0) {
      console.log(chalk.dim('No memories stored for user "' + userId + '".'));
      return;
    }

    const { confirm } = await prompt<{ confirm: boolean }>({
      type: "confirm",
      name: "confirm",
      message:
        "Delete all " +
        memories.length +
        ' memories for user "' + userId + '"?',
      initial: false,
    });

    if (!confirm) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }

    await store.deleteAll(userId);
    console.log(renderMemoryCleared(userId, memories.length));
  } finally {
    await closeStore(store);
  }
}

/* ------------------------------------------------------------------ */
/*  export                                                             */
/* ------------------------------------------------------------------ */

export async function memoryExportCommand(
  opts: MemoryOptions & { format?: string; out?: string },
): Promise<void> {
  const userId = requireUser(opts);
  const format = (opts.format ?? "json").toLowerCase();
  if (format !== "json" && format !== "csv") {
    console.error(chalk.red("--format must be 'json' or 'csv'"));
    process.exit(1);
  }
  const store = resolveStore();
  try {
    const memories = await store.list(userId);
    const body =
      format === "json"
        ? exportMemoriesJson(memories)
        : exportMemoriesCsv(memories);

    if (opts.out) {
      writeFileSync(opts.out, body, "utf8");
      console.log(
        chalk.green("✓") +
          " Wrote " +
          chalk.bold(String(memories.length)) +
          " memor" +
          (memories.length === 1 ? "y" : "ies") +
          " to " +
          chalk.bold(opts.out),
      );
    } else {
      // Stream to stdout so callers can pipe to jq / xsv / etc.
      process.stdout.write(body);
    }
  } finally {
    await closeStore(store);
  }
}
