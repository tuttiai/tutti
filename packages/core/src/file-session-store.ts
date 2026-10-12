import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import type { ChatMessage, Session, SessionStore } from "@tuttiai/types";

import { TEMP_SUFFIX, writeFileAtomic } from "./atomic-file.js";
import { logger } from "./logger.js";
import { SessionLru, type SessionStoreBounds } from "./session-lru.js";

/**
 * The session ids {@link FileSessionStore} accepts. An id becomes a file
 * name, so anything that could name another path (a slash, a dot, a NUL) is
 * refused rather than escaped.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Options for {@link FileSessionStore}. */
export type FileSessionStoreOptions = SessionStoreBounds;

const FILE_SUFFIX = ".json";

const StoredSessionSchema = z.object({
  id: z.string().regex(SESSION_ID_PATTERN),
  agent_name: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]),
    }),
  ),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

/**
 * Keeps sessions in a directory, one JSON file per session (`<dir>/<id>.json`),
 * so they survive a restart. Every change is written through at once, by a
 * temporary file renamed into place, so a crash never leaves half a session.
 *
 * Sessions are held in memory as well and read from disk on first `get`. The
 * same bounds as {@link InMemorySessionStore} apply, measured from the last use
 * (after a restart, from the file's last write), and evicting a session
 * deletes its file. One process per directory: two writing the same directory
 * would each evict the other's sessions by their own count.
 *
 * @example
 * const runtime = new TuttiRuntime(score, {
 *   sessionStore: new FileSessionStore("/state/sessions"),
 * });
 */
export class FileSessionStore implements SessionStore {
  private readonly dir: string;
  private readonly cache = new Map<string, Session>();
  private readonly lru: SessionLru;

  /**
   * @param dir - The directory to keep sessions in. Created when missing.
   * @param options - Cap, idle time to live and clock. Every field is optional.
   * @throws {Error} When the directory cannot be created, written or listed.
   */
  constructor(dir: string, options: FileSessionStoreOptions = {}) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Fail here, where the caller can fall back, rather than on every later write.
    accessSync(dir, constants.W_OK);
    this.lru = new SessionLru(options, (id) => this.drop(id));
    this.scan();
  }

  create(agent_name: string): Session {
    const now = new Date();
    const session: Session = { id: randomUUID(), agent_name, messages: [], created_at: now, updated_at: now };
    this.save(session);
    return session;
  }

  get(id: string): Session | undefined {
    if (!SESSION_ID_PATTERN.test(id) || !this.lru.isLive(id)) return undefined;
    const session = this.cache.get(id) ?? this.read(id);
    if (!session) {
      // Unreadable: stop tracking it, but leave the file for whoever wants to see why.
      this.lru.forget(id);
      return undefined;
    }
    this.cache.set(id, session);
    this.lru.touch(id);
    return session;
  }

  update(id: string, messages: ChatMessage[]): void {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.messages = messages;
    session.updated_at = new Date();
    this.persist(session);
  }

  /**
   * Insert-or-replace a session under its own id, as
   * {@link InMemorySessionStore.save} does. Used by flows that rewrite a
   * session's history, such as the server's replay route.
   *
   * @param session - The session to keep.
   * @throws {Error} When the id does not match {@link SESSION_ID_PATTERN}.
   */
  save(session: Session): void {
    if (!SESSION_ID_PATTERN.test(session.id)) {
      throw new Error(
        `Invalid session id "${session.id.slice(0, 140)}".\n` +
          "A session id may hold only letters, digits, _ and -, at most 128 of them.",
      );
    }
    this.cache.set(session.id, session);
    this.persist(session);
    this.lru.touch(session.id);
  }

  private path(id: string): string {
    return join(this.dir, `${id}${FILE_SUFFIX}`);
  }

  /** Register the sessions already on disk, oldest write first, and clear abandoned temporary files. */
  private scan(): void {
    const found: { id: string; at: number }[] = [];
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(TEMP_SUFFIX)) {
        rmSync(join(this.dir, name), { force: true });
        continue;
      }
      const id = name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : "";
      if (!SESSION_ID_PATTERN.test(id)) continue;
      found.push({ id, at: statSync(this.path(id)).mtimeMs });
    }
    found.sort((a, b) => a.at - b.at);
    for (const { id, at } of found) this.lru.touch(id, at);
  }

  private read(id: string): Session | undefined {
    try {
      const parsed = StoredSessionSchema.safeParse(JSON.parse(readFileSync(this.path(id), "utf8")));
      if (parsed.success && parsed.data.id === id) return revive(parsed.data);
      logger.warn({ session: id }, "Ignoring a session file that does not hold a session");
    } catch (error) {
      logger.warn({ session: id, error: describe(error) }, "Ignoring an unreadable session file");
    }
    return undefined;
  }

  private persist(session: Session): void {
    try {
      writeFileAtomic(this.path(session.id), JSON.stringify(session));
    } catch (error) {
      // The run carries on from memory; only surviving a restart is lost.
      logger.error({ session: session.id, error: describe(error) }, "Failed to write session to disk");
    }
  }

  private drop(id: string): void {
    this.cache.delete(id);
    try {
      rmSync(this.path(id), { force: true });
    } catch (error) {
      logger.warn({ session: id, error: describe(error) }, "Failed to delete an evicted session file");
    }
  }
}

function revive(stored: z.infer<typeof StoredSessionSchema>): Session {
  return {
    id: stored.id,
    agent_name: stored.agent_name,
    // Safe: the schema checked each message's role and content shape, and the
    // blocks are ones this store wrote from a ChatMessage in the first place.
    messages: stored.messages as ChatMessage[],
    created_at: new Date(stored.created_at),
    updated_at: new Date(stored.updated_at),
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
