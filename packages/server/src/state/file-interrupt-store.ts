/**
 * A file-backed {@link InterruptStore} for the server image, so pending
 * approvals survive a restart when `TUTTI_STATE_DIR` is set. Internal to
 * `@tuttiai/server`: not exported from its index.
 *
 * @module
 */

import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";
import { TuttiError, createLogger } from "@tuttiai/core";
import type { InterruptCreateInput, InterruptRequest, InterruptStore, ResolveOptions } from "@tuttiai/core";

import { attempt, removeStrayTemps, writeFileAtomic } from "./atomic-write.js";

/** The interrupt ids this store accepts: the UUIDs it generates. Anything else never reaches the filesystem. */
export const INTERRUPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The error code `get` and `resolve` throw for a record that cannot be read. */
export const INTERRUPT_RECORD_CORRUPT = "INTERRUPT_RECORD_CORRUPT";

const FILE_SUFFIX = ".json";

const StoredInterruptSchema = z.object({
  interrupt_id: z.string().regex(INTERRUPT_ID_PATTERN),
  session_id: z.string().min(1),
  tool_name: z.string().min(1),
  tool_args: z.unknown(),
  requested_at: z.string().datetime(),
  status: z.enum(["pending", "approved", "denied"]),
  resolved_at: z.string().datetime().optional(),
  resolved_by: z.string().optional(),
  denial_reason: z.string().optional(),
});

type StoredInterrupt = z.infer<typeof StoredInterruptSchema>;

/** Reports a record set aside while listing. Gets the id only, never the record. */
export type CorruptRecordWarn = (ctx: { interrupt_id: string }, msg: string) => void;

const defaultWarn: CorruptRecordWarn = (ctx, msg) => createLogger("tutti-server").warn(ctx, msg);

/**
 * Keeps approval records in a directory, one JSON file per record
 * (`<dir>/<interrupt_id>.json`, mode 0600), each written by a temporary
 * file renamed into place. One record per file means a corrupt record costs
 * only itself. All file work is synchronous, so two resolves in one process
 * never interleave and a second resolve returns the first's record
 * unchanged. One process per directory.
 */
export class FileInterruptStore implements InterruptStore {
  /**
   * @param dir - The directory to keep records in. Created when missing.
   * @param warn - Where a corrupt record found while listing is reported.
   * @throws {Error} When the directory cannot be created or written, so the caller can fall back.
   */
  constructor(
    private readonly dir: string,
    private readonly warn: CorruptRecordWarn = defaultWarn,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    accessSync(dir, constants.W_OK);
    removeStrayTemps(dir);
  }

  create(input: InterruptCreateInput): Promise<InterruptRequest> {
    const request: InterruptRequest = {
      interrupt_id: randomUUID(),
      session_id: input.session_id,
      tool_name: input.tool_name,
      tool_args: input.tool_args,
      requested_at: new Date(),
      status: "pending",
    };
    return attempt(() => {
      this.write(request);
      return request;
    });
  }

  get(interrupt_id: string): Promise<InterruptRequest | null> {
    return attempt(() => this.read(interrupt_id));
  }

  resolve(interrupt_id: string, status: "approved" | "denied", options: ResolveOptions = {}): Promise<InterruptRequest> {
    return attempt(() => {
      const existing = this.read(interrupt_id);
      if (!existing) throw new Error(`FileInterruptStore: unknown interrupt_id ${interrupt_id}`);
      if (existing.status !== "pending") return existing;
      const resolved: InterruptRequest = {
        ...existing,
        status,
        resolved_at: new Date(),
        ...(options.resolved_by !== undefined ? { resolved_by: options.resolved_by } : {}),
        ...(options.denial_reason !== undefined ? { denial_reason: options.denial_reason } : {}),
      };
      this.write(resolved);
      return resolved;
    });
  }

  listPending(session_id?: string): Promise<InterruptRequest[]> {
    return attempt(() =>
      this.readAll().filter((r) => r.status === "pending" && (session_id === undefined || r.session_id === session_id)),
    );
  }

  listBySession(session_id: string): Promise<InterruptRequest[]> {
    return attempt(() => this.readAll().filter((r) => r.session_id === session_id));
  }

  private path(interrupt_id: string): string {
    return join(this.dir, `${interrupt_id}${FILE_SUFFIX}`);
  }

  private write(request: InterruptRequest): void {
    writeFileAtomic(this.path(request.interrupt_id), JSON.stringify(request));
  }

  /** `null` for an id outside the pattern or with no file; throws for a record that cannot be read. */
  private read(interrupt_id: string): InterruptRequest | null {
    if (!INTERRUPT_ID_PATTERN.test(interrupt_id) || !existsSync(this.path(interrupt_id))) return null;
    const stored = parseRecord(this.path(interrupt_id), interrupt_id);
    if (!stored) {
      throw new TuttiError(INTERRUPT_RECORD_CORRUPT, `interrupt ${interrupt_id} record is unreadable`, { interrupt_id });
    }
    return revive(stored);
  }

  /** Every readable record, oldest first. A corrupt one is skipped with a warning naming its id. */
  private readAll(): InterruptRequest[] {
    const records: InterruptRequest[] = [];
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith(FILE_SUFFIX) ? name.slice(0, -FILE_SUFFIX.length) : "";
      if (!INTERRUPT_ID_PATTERN.test(id)) continue;
      const stored = parseRecord(this.path(id), id);
      if (stored) records.push(revive(stored));
      else this.warn({ interrupt_id: id }, "Skipping an approval record that cannot be read");
    }
    return records.sort((a, b) => a.requested_at.getTime() - b.requested_at.getTime());
  }
}

function parseRecord(path: string, interrupt_id: string): StoredInterrupt | undefined {
  try {
    const parsed = StoredInterruptSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success && parsed.data.interrupt_id === interrupt_id ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function revive(stored: StoredInterrupt): InterruptRequest {
  return {
    interrupt_id: stored.interrupt_id,
    session_id: stored.session_id,
    tool_name: stored.tool_name,
    tool_args: stored.tool_args,
    requested_at: new Date(stored.requested_at),
    status: stored.status,
    ...(stored.resolved_at !== undefined ? { resolved_at: new Date(stored.resolved_at) } : {}),
    ...(stored.resolved_by !== undefined ? { resolved_by: stored.resolved_by } : {}),
    ...(stored.denial_reason !== undefined ? { denial_reason: stored.denial_reason } : {}),
  };
}
