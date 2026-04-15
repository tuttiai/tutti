import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { JsonFileGoldenStore } from "../../../src/eval/golden/json-file-store.js";
import type { GoldenCase, GoldenRun } from "../../../src/eval/golden/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCase(overrides: Partial<GoldenCase> = {}): GoldenCase {
  return {
    id: "",
    name: "summarize Q1 report",
    agent_id: "assistant",
    input: "Summarize the Q1 report.",
    scorers: [{ type: "exact" }],
    created_at: new Date("2026-04-15T12:00:00.000Z"),
    ...overrides,
  };
}

function makeRun(case_id: string, overrides: Partial<GoldenRun> = {}): GoldenRun {
  return {
    id: "",
    case_id,
    ran_at: new Date("2026-04-15T12:05:00.000Z"),
    output: "Q1 revenue rose 12%.",
    tool_sequence: ["search_knowledge"],
    tokens: 420,
    scores: {
      exact: { scorer: "exact", score: 1, passed: true },
    },
    passed: true,
    ...overrides,
  };
}

// ===========================================================================

describe("JsonFileGoldenStore — cases", () => {
  let dir: string;
  let store: JsonFileGoldenStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-golden-"));
    store = new JsonFileGoldenStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveCase assigns an id when blank and persists to cases.json", async () => {
    const saved = await store.saveCase(makeCase());

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.name).toBe("summarize Q1 report");

    const onDisk: unknown = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"));
    expect(Array.isArray(onDisk)).toBe(true);
    expect((onDisk as Array<{ id: string }>)[0]?.id).toBe(saved.id);
  });

  it("preserves an explicit id across save", async () => {
    const saved = await store.saveCase(makeCase({ id: "fixed-id" }));
    expect(saved.id).toBe("fixed-id");

    const reread = await store.getCase("fixed-id");
    expect(reread?.name).toBe("summarize Q1 report");
  });

  it("listCases returns every saved case, oldest first, with dates revived", async () => {
    const earlier = await store.saveCase(makeCase({
      name: "A",
      created_at: new Date("2026-04-10T00:00:00.000Z"),
    }));
    const later = await store.saveCase(makeCase({
      name: "B",
      created_at: new Date("2026-04-14T00:00:00.000Z"),
    }));

    const listed = await store.listCases();
    expect(listed.map((c) => c.id)).toEqual([earlier.id, later.id]);
    expect(listed[0]!.created_at).toBeInstanceOf(Date);
    expect(listed[0]!.created_at.toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });

  it("getCase returns null for unknown ids", async () => {
    expect(await store.getCase("nope")).toBeNull();
  });

  it("saveCase replaces an existing case by id and keeps the original created_at", async () => {
    const original = await store.saveCase(makeCase({ name: "v1" }));
    const updated = await store.saveCase({
      ...original,
      name: "v2",
      // Caller may accidentally change created_at; the store must ignore.
      created_at: new Date("2099-01-01T00:00:00.000Z"),
    });

    expect(updated.id).toBe(original.id);
    expect(updated.name).toBe("v2");
    expect(updated.created_at.toISOString()).toBe(original.created_at.toISOString());

    const all = await store.listCases();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe("v2");
  });

  it("deleteCase removes the case and its recorded runs", async () => {
    const c = await store.saveCase(makeCase());
    await store.saveRun(makeRun(c.id));
    expect(existsSync(join(dir, "runs", `${c.id}.json`))).toBe(true);

    await store.deleteCase(c.id);

    expect(await store.getCase(c.id)).toBeNull();
    expect(await store.listRuns(c.id)).toEqual([]);
    expect(existsSync(join(dir, "runs", `${c.id}.json`))).toBe(false);
  });

  it("deleteCase is a no-op for unknown ids", async () => {
    await expect(store.deleteCase("nope")).resolves.toBeUndefined();
  });

  it("round-trips optional fields (expected_output, tags, promoted_from_session)", async () => {
    const saved = await store.saveCase(makeCase({
      expected_output: "Revenue up 12%.",
      expected_tool_sequence: ["search_knowledge", "web_search"],
      tags: ["smoke", "regression"],
      promoted_from_session: "sess-abc",
    }));

    const fresh = new JsonFileGoldenStore(dir);
    const reread = await fresh.getCase(saved.id);
    expect(reread?.expected_output).toBe("Revenue up 12%.");
    expect(reread?.expected_tool_sequence).toEqual(["search_knowledge", "web_search"]);
    expect(reread?.tags).toEqual(["smoke", "regression"]);
    expect(reread?.promoted_from_session).toBe("sess-abc");
  });
});

// ===========================================================================

describe("JsonFileGoldenStore — runs", () => {
  let dir: string;
  let store: JsonFileGoldenStore;
  let caseId: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "tutti-golden-"));
    store = new JsonFileGoldenStore(dir);
    const c = await store.saveCase(makeCase());
    caseId = c.id;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveRun assigns an id when blank and writes runs/<case-id>.json", async () => {
    const saved = await store.saveRun(makeRun(caseId));

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.case_id).toBe(caseId);
    expect(existsSync(join(dir, "runs", `${caseId}.json`))).toBe(true);
  });

  it("getRun looks up a run by id across cases", async () => {
    const saved = await store.saveRun(makeRun(caseId, { output: "hit" }));
    const found = await store.getRun(saved.id);
    expect(found?.output).toBe("hit");
  });

  it("getRun returns null for unknown ids", async () => {
    expect(await store.getRun("nope")).toBeNull();
  });

  it("listRuns returns every run for the case, oldest first", async () => {
    const older = await store.saveRun(makeRun(caseId, {
      ran_at: new Date("2026-04-15T10:00:00.000Z"),
      output: "older",
    }));
    const newer = await store.saveRun(makeRun(caseId, {
      ran_at: new Date("2026-04-15T11:00:00.000Z"),
      output: "newer",
    }));

    const runs = await store.listRuns(caseId);
    expect(runs.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(runs[0]!.ran_at).toBeInstanceOf(Date);
  });

  it("listRuns returns [] for a case with no recorded runs", async () => {
    const other = await store.saveCase(makeCase({ name: "empty" }));
    expect(await store.listRuns(other.id)).toEqual([]);
  });

  it("latestRun returns the most recently executed run", async () => {
    await store.saveRun(makeRun(caseId, {
      ran_at: new Date("2026-04-15T10:00:00.000Z"),
      output: "older",
      passed: false,
    }));
    const newer = await store.saveRun(makeRun(caseId, {
      ran_at: new Date("2026-04-15T11:00:00.000Z"),
      output: "newer",
      passed: true,
    }));

    const latest = await store.latestRun(caseId);
    expect(latest?.id).toBe(newer.id);
    expect(latest?.output).toBe("newer");
    expect(latest?.passed).toBe(true);
  });

  it("latestRun returns null when the case has no runs", async () => {
    expect(await store.latestRun(caseId)).toBeNull();
  });

  it("saveRun replaces an existing run by id", async () => {
    const first = await store.saveRun(makeRun(caseId, { id: "r1", output: "v1" }));
    const updated = await store.saveRun({ ...first, output: "v2" });

    expect(updated.id).toBe("r1");
    const runs = await store.listRuns(caseId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.output).toBe("v2");
  });

  it("persists scores and diff round-trip", async () => {
    const saved = await store.saveRun(makeRun(caseId, {
      scores: {
        exact: { scorer: "exact", score: 0, passed: false, detail: "mismatch at 0" },
        similarity: { scorer: "similarity", score: 0.82, passed: true },
      },
      diff: "- old\n+ new",
      passed: false,
    }));

    const fresh = new JsonFileGoldenStore(dir);
    const reread = await fresh.getRun(saved.id);
    expect(reread?.scores["exact"]?.passed).toBe(false);
    expect(reread?.scores["similarity"]?.score).toBe(0.82);
    expect(reread?.diff).toBe("- old\n+ new");
    expect(reread?.passed).toBe(false);
  });
});
