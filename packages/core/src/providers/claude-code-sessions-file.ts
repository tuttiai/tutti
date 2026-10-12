import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "../atomic-file.js";
import { logger } from "../logger.js";

/*
 * Why the registry is kept on disk. Claude Code's own session files outlive
 * the process, but the map from a conversation to its session did not, so a
 * restarted server sent every conversation's whole transcript to a fresh
 * session and paid to cache it again. The file holds only hashes and session
 * ids, never message content.
 */

const EntrySchema = z.object({ session_id: z.string().min(1), stored_at: z.number().finite() });

const RegistryFileSchema = z.object({
  version: z.literal(1),
  /** Oldest first, so reading them back in order restores which is forgotten first. */
  entries: z.array(z.tuple([z.string().min(1), EntrySchema])),
});

/** One remembered conversation: the session holding it, and when it was stored. */
export type ResumeEntry = z.infer<typeof EntrySchema>;

/** What {@link readResumeEntries} keeps. */
export interface ResumeEntryLimits {
  max_entries: number;
  ttl_ms: number;
  now: number;
}

/**
 * Read a registry file, dropping entries past their time to live and the
 * oldest over the cap. A missing file is an empty registry; an unreadable or
 * malformed one is logged and treated the same, because losing the registry
 * only costs a cache write, and refusing to start would cost the agent.
 *
 * @param file - The registry file.
 * @param limits - Cap, time to live and the current time.
 * @returns The live entries, oldest first.
 */
export function readResumeEntries(file: string, limits: ResumeEntryLimits): Map<string, ResumeEntry> {
  const entries = new Map<string, ResumeEntry>();
  for (const [key, entry] of readRegistry(file)) {
    if (limits.now - entry.stored_at > limits.ttl_ms) continue;
    entries.delete(key);
    entries.set(key, entry);
  }
  for (const oldest of entries.keys()) {
    if (entries.size <= limits.max_entries) break;
    entries.delete(oldest);
  }
  return entries;
}

function readRegistry(file: string): [string, ResumeEntry][] {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (!isMissing(error)) {
      logger.warn({ file, error: describe(error) }, "Cannot read the Claude Code session registry; starting empty");
    }
    return [];
  }
  const parsed = RegistryFileSchema.safeParse(json);
  if (parsed.success) return parsed.data.entries;
  logger.warn({ file }, "The Claude Code session registry is malformed; starting empty");
  return [];
}

/**
 * Rewrite a registry file atomically, creating its directory when missing.
 * A failure is logged, not thrown: the registry in memory still works.
 *
 * @param file - The registry file.
 * @param entries - Every entry, oldest first.
 */
export function writeResumeEntries(file: string, entries: Map<string, ResumeEntry>): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileAtomic(file, JSON.stringify({ version: 1, entries: [...entries] }));
  } catch (error) {
    logger.warn({ file, error: describe(error) }, "Cannot write the Claude Code session registry");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
