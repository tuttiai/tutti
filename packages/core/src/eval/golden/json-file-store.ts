import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { GoldenStore } from "./store.js";
import type { GoldenCase, GoldenRun } from "./types.js";

/**
 * Default base directory for on-disk golden data. Resolved against the
 * process CWD at construction time — callers who want to point elsewhere
 * (e.g. tests using a tmpdir) pass an explicit path.
 */
export const DEFAULT_GOLDEN_BASE_PATH = ".tutti/golden";

const CASES_FILE = "cases.json";
const RUNS_DIR = "runs";

/**
 * File-backed {@link GoldenStore} — the default storage driver.
 *
 * Layout under `basePath` (defaults to `.tutti/golden`, resolved against
 * the process CWD):
 *
 *     <basePath>/cases.json              — JSON array of every GoldenCase
 *     <basePath>/runs/<case-id>.json     — JSON array of that case's runs
 *
 * Writes are atomic: each file is written to a sibling `*.tmp` path and
 * then renamed over the target so readers never see a half-written file.
 * Dates are serialised as ISO strings and revived on read.
 *
 * Suitable for committing the golden dataset into a repo so CI can detect
 * regressions. Not concurrent-safe across processes — callers that want
 * that should use a database-backed store.
 */
export class JsonFileGoldenStore implements GoldenStore {
  private readonly basePath: string;

  constructor(basePath: string = DEFAULT_GOLDEN_BASE_PATH) {
    this.basePath = resolve(basePath);
  }

  async saveCase(golden_case: GoldenCase): Promise<GoldenCase> {
    const cases = await this.readCases();
    const id = golden_case.id !== "" ? golden_case.id : randomUUID();
    const existing = cases.find((c) => c.id === id);
    const stored: GoldenCase = {
      ...golden_case,
      id,
      // Preserve the original created_at across updates.
      created_at: existing?.created_at ?? golden_case.created_at ?? new Date(),
    };
    const next = existing
      ? cases.map((c) => (c.id === id ? stored : c))
      : [...cases, stored];
    await this.writeCases(next);
    return stored;
  }

  async getCase(id: string): Promise<GoldenCase | null> {
    const cases = await this.readCases();
    return cases.find((c) => c.id === id) ?? null;
  }

  async listCases(): Promise<GoldenCase[]> {
    const cases = await this.readCases();
    return [...cases].sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  async deleteCase(id: string): Promise<void> {
    const cases = await this.readCases();
    const next = cases.filter((c) => c.id !== id);
    if (next.length !== cases.length) {
      await this.writeCases(next);
    }
    await rm(this.runsPath(id), { force: true });
  }

  async saveRun(run: GoldenRun): Promise<GoldenRun> {
    const runs = await this.readRuns(run.case_id);
    const id = run.id !== "" ? run.id : randomUUID();
    const stored: GoldenRun = { ...run, id };
    const existing = runs.findIndex((r) => r.id === id);
    const next = existing >= 0
      ? runs.map((r, i) => (i === existing ? stored : r))
      : [...runs, stored];
    await this.writeRuns(run.case_id, next);
    return stored;
  }

  async getRun(id: string): Promise<GoldenRun | null> {
    const caseIds = await this.listRunCaseIds();
    for (const caseId of caseIds) {
      const runs = await this.readRuns(caseId);
      const hit = runs.find((r) => r.id === id);
      if (hit) return hit;
    }
    return null;
  }

  async listRuns(case_id: string): Promise<GoldenRun[]> {
    const runs = await this.readRuns(case_id);
    return [...runs].sort((a, b) => a.ran_at.getTime() - b.ran_at.getTime());
  }

  async latestRun(case_id: string): Promise<GoldenRun | null> {
    const runs = await this.listRuns(case_id);
    return runs.at(-1) ?? null;
  }

  // ---- private: file I/O ---------------------------------------------------

  private casesPath(): string {
    return join(this.basePath, CASES_FILE);
  }

  private runsPath(case_id: string): string {
    return join(this.basePath, RUNS_DIR, `${case_id}.json`);
  }

  private async readCases(): Promise<GoldenCase[]> {
    const raw = await readJsonArray(this.casesPath());
    return raw.map(reviveCase);
  }

  private async writeCases(cases: GoldenCase[]): Promise<void> {
    await writeJsonAtomic(this.casesPath(), cases);
  }

  private async readRuns(case_id: string): Promise<GoldenRun[]> {
    const raw = await readJsonArray(this.runsPath(case_id));
    return raw.map(reviveRun);
  }

  private async writeRuns(case_id: string, runs: GoldenRun[]): Promise<void> {
    await writeJsonAtomic(this.runsPath(case_id), runs);
  }

  private async listRunCaseIds(): Promise<string[]> {
    const dir = join(this.basePath, RUNS_DIR);
    const entries = await safeReaddir(dir);
    return entries
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length));
  }
}

// ----- helpers (module-private) ---------------------------------------------

async function readJsonArray(path: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isUnknownArray(parsed)) {
    throw new Error(`Corrupt golden file at ${path}: expected a JSON array`);
  }
  return parsed;
}

/**
 * Local `Array.isArray` guard that narrows to `unknown[]` instead of
 * `any[]` — the built-in version widens the element type and defeats our
 * `no-unsafe-return` guarantees at the caller.
 */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await rename(tmp, path);
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function reviveCase(raw: unknown): GoldenCase {
  const r = raw as GoldenCase & { created_at: string | Date };
  return { ...r, created_at: toDate(r.created_at) };
}

function reviveRun(raw: unknown): GoldenRun {
  const r = raw as GoldenRun & { ran_at: string | Date };
  return { ...r, ran_at: toDate(r.ran_at) };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}
