import type { ScheduleStore } from "./store.js";
import type { ScheduleRecord, ScheduledRun } from "./types.js";

/**
 * In-memory {@link ScheduleStore} — suitable for dev and tests.
 *
 * Not durable across process restarts. Inputs and outputs are
 * deep-cloned with `structuredClone` to prevent mutation bugs.
 */
export class MemoryScheduleStore implements ScheduleStore {
  private readonly records = new Map<string, ScheduleRecord>();
  private readonly runs = new Map<string, ScheduledRun[]>();

  save(record: ScheduleRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
    return Promise.resolve();
  }

  get(id: string): Promise<ScheduleRecord | null> {
    const r = this.records.get(id);
    return Promise.resolve(r ? structuredClone(r) : null);
  }

  list(): Promise<ScheduleRecord[]> {
    const sorted = Array.from(this.records.values())
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => structuredClone(r));
    return Promise.resolve(sorted);
  }

  delete(id: string): Promise<void> {
    this.records.delete(id);
    this.runs.delete(id);
    return Promise.resolve();
  }

  addRun(id: string, run: ScheduledRun): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.run_count += 1;
    }
    const list = this.runs.get(id) ?? [];
    list.push(structuredClone(run));
    this.runs.set(id, list);
    return Promise.resolve();
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.records.get(id);
    if (record) {
      record.enabled = enabled;
    }
    return Promise.resolve();
  }

  /** Retrieve all runs for a schedule (test helper). */
  getRuns(id: string): ScheduledRun[] {
    return structuredClone(this.runs.get(id) ?? []);
  }
}
