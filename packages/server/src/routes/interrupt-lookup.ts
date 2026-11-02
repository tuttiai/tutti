/**
 * Reading one approval record for the approve and deny routes, with the
 * answers an operator sees when it is missing or cannot be read.
 */

import { TuttiError } from "@tuttiai/core";
import type { InterruptRequest, InterruptStore } from "@tuttiai/core";

import { INTERRUPT_RECORD_CORRUPT } from "../state/file-interrupt-store.js";

/** The record, or the status and body to answer with instead. */
export type InterruptLookup =
  | { ok: true; record: InterruptRequest }
  | { ok: false; status: 404 | 500; body: { error: string; message: string } };

/**
 * Read an approval record.
 *
 * @param store - The runtime's interrupt store.
 * @param interrupt_id - The id from the URL.
 * @returns The record; a 404 when there is none; a 500 naming only the id
 *   when the record cannot be read, never its content.
 * @throws Whatever else the store throws, for the global error handler.
 */
export async function lookupInterrupt(store: InterruptStore, interrupt_id: string): Promise<InterruptLookup> {
  try {
    const record = await store.get(interrupt_id);
    if (record) return { ok: true, record };
    return {
      ok: false,
      status: 404,
      body: { error: "interrupt_not_found", message: `No interrupt with id "${interrupt_id}"` },
    };
  } catch (error) {
    if (!(error instanceof TuttiError) || error.code !== INTERRUPT_RECORD_CORRUPT) throw error;
    return {
      ok: false,
      status: 500,
      body: { error: "interrupt_record_corrupt", message: `interrupt ${interrupt_id} record is unreadable` },
    };
  }
}
