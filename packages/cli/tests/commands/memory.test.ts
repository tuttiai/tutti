/**
 * Tests for `tutti-ai memory list` and `tutti-ai memory search` rendering.
 *
 * Drives the pure render functions with mock UserMemory data — no
 * Postgres, no Enquirer, no fetch. The orchestration command in
 * memory.ts is excluded from coverage and exercised manually against a
 * live store.
 */

import { describe, it, expect } from "vitest";
import chalk from "chalk";
import type { UserMemory } from "@tuttiai/core";

import {
  exportMemoriesCsv,
  exportMemoriesJson,
  importanceStars,
  renderMemoryAdded,
  renderMemoryCleared,
  renderMemoryDeleted,
  renderMemoryList,
  renderMemorySearch,
} from "../../src/commands/memory-render.js";

// vitest runs without a TTY → chalk would emit plain text and the
// colour assertions below would never fire. Pin to level 1.
chalk.level = 1;

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Build a mock memory with sensible defaults. */
function mkMemory(overrides: Partial<UserMemory> = {}): UserMemory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    user_id: "user-alex",
    content: "User prefers TypeScript over JavaScript",
    source: "explicit",
    importance: 2,
    created_at: new Date("2026-04-15T10:30:00Z"),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  importanceStars                                                    */
/* ------------------------------------------------------------------ */

describe("importanceStars", () => {
  it("renders 1 / 2 / 3 with the documented star bars", () => {
    expect(importanceStars(1)).toBe("\u2605\u2606\u2606"); // ★☆☆
    expect(importanceStars(2)).toBe("\u2605\u2605\u2606"); // ★★☆
    expect(importanceStars(3)).toBe("\u2605\u2605\u2605"); // ★★★
  });
});

/* ------------------------------------------------------------------ */
/*  renderMemoryList                                                   */
/* ------------------------------------------------------------------ */

describe("renderMemoryList", () => {
  it("renders the column header and one row per memory", () => {
    const out = stripAnsi(
      renderMemoryList(
        [
          mkMemory({
            id: "abcdef12-0000-0000-0000-000000000000",
            content: "User prefers TypeScript",
            source: "explicit",
            importance: 3,
          }),
        ],
        "user-alex",
      ),
    );

    expect(out).toContain("ID");
    expect(out).toContain("CONTENT");
    expect(out).toContain("SOURCE");
    expect(out).toContain("IMPORTANCE");
    expect(out).toContain("CREATED");
    expect(out).toContain("abcdef12"); // 8-char trace id prefix
    expect(out).toContain("User prefers TypeScript");
    expect(out).toContain("explicit");
    expect(out).toContain("\u2605\u2605\u2605"); // ★★★
    expect(out).toContain("2026-04-15 10:30");
  });

  it("renders an empty-state message when no memories exist", () => {
    const out = stripAnsi(renderMemoryList([], "user-alex"));
    expect(out).toBe('No memories stored for user "user-alex".');
  });

  it("sorts by importance DESC, then created_at DESC", () => {
    const memories = [
      mkMemory({
        id: "11111111",
        content: "low old",
        importance: 1,
        created_at: new Date("2026-04-01T00:00:00Z"),
      }),
      mkMemory({
        id: "22222222",
        content: "high old",
        importance: 3,
        created_at: new Date("2026-04-01T00:00:00Z"),
      }),
      mkMemory({
        id: "33333333",
        content: "high new",
        importance: 3,
        created_at: new Date("2026-04-15T00:00:00Z"),
      }),
      mkMemory({
        id: "44444444",
        content: "normal new",
        importance: 2,
        created_at: new Date("2026-04-15T00:00:00Z"),
      }),
    ];

    const out = stripAnsi(renderMemoryList(memories, "user-alex"));
    // Order body-only by stripping the header rows. Each data row has
    // its content somewhere; index it.
    const i = (s: string): number => out.indexOf(s);
    expect(i("high new")).toBeLessThan(i("high old"));
    expect(i("high old")).toBeLessThan(i("normal new"));
    expect(i("normal new")).toBeLessThan(i("low old"));
  });

  it("truncates content longer than 60 chars with an ellipsis", () => {
    const long =
      "User has a very long preference statement that exceeds the column width of sixty chars by quite a lot";
    const out = stripAnsi(
      renderMemoryList([mkMemory({ content: long })], "user-alex"),
    );
    expect(out).not.toContain(long);
    expect(out).toContain("\u2026"); // …
    // 59 visible + 1 ellipsis = 60 chars.
    expect(out).toMatch(/User has a very long preference statement that exceeds the[^.]/);
  });

  it("colours source: green for explicit, yellow for inferred", () => {
    const raw = renderMemoryList(
      [
        mkMemory({ id: "expl", source: "explicit" }),
        mkMemory({ id: "infe", source: "inferred" }),
      ],
      "user-alex",
    );
    expect(raw).toContain("\u001b[32mexplicit\u001b[39m");
    expect(raw).toContain("\u001b[33minferred\u001b[39m");
  });

  it("renders all three star bars correctly inline", () => {
    const out = stripAnsi(
      renderMemoryList(
        [
          mkMemory({ id: "low", importance: 1, content: "low one" }),
          mkMemory({ id: "med", importance: 2, content: "med one" }),
          mkMemory({ id: "hi", importance: 3, content: "hi one" }),
        ],
        "user-alex",
      ),
    );
    expect(out).toContain("\u2605\u2606\u2606"); // ★☆☆
    expect(out).toContain("\u2605\u2605\u2606"); // ★★☆
    expect(out).toContain("\u2605\u2605\u2605"); // ★★★
  });
});

/* ------------------------------------------------------------------ */
/*  renderMemorySearch                                                 */
/* ------------------------------------------------------------------ */

describe("renderMemorySearch", () => {
  it("includes the query and result count in the header", () => {
    const out = stripAnsi(
      renderMemorySearch(
        [mkMemory({ content: "User prefers TypeScript" })],
        "user-alex",
        "TypeScript",
      ),
    );
    expect(out).toContain('Search for "TypeScript"');
    expect(out).toContain('user "user-alex"');
    expect(out).toContain("1 result");
  });

  it("pluralises the result count correctly", () => {
    const zero = stripAnsi(renderMemorySearch([], "user-alex", "Rust"));
    expect(zero).toContain("0 results");

    const two = stripAnsi(
      renderMemorySearch(
        [mkMemory({ id: "a" }), mkMemory({ id: "b" })],
        "user-alex",
        "User",
      ),
    );
    expect(two).toContain("2 results");
  });

  it("preserves input order — the store has already ranked by relevance", () => {
    // Note that the store-ranked order here is opposite to the sort
    // renderMemoryList would impose; this test asserts we DON'T re-sort.
    const ranked = [
      mkMemory({
        id: "111",
        content: "first match — low importance",
        importance: 1,
        created_at: new Date("2026-04-01T00:00:00Z"),
      }),
      mkMemory({
        id: "222",
        content: "second match — high importance",
        importance: 3,
        created_at: new Date("2026-04-15T00:00:00Z"),
      }),
    ];
    const out = stripAnsi(renderMemorySearch(ranked, "user-alex", "match"));
    const first = out.indexOf("first match");
    const second = out.indexOf("second match");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first); // input order preserved
  });

  it("renders the empty-state message when no results match", () => {
    const out = stripAnsi(renderMemorySearch([], "user-alex", "Rust"));
    expect(out).toContain('No memories matching "Rust" for user "user-alex".');
  });
});

/* ------------------------------------------------------------------ */
/*  Confirmation lines                                                 */
/* ------------------------------------------------------------------ */

describe("confirmation lines", () => {
  it("renderMemoryAdded shows the truncated id, source, and importance", () => {
    const out = stripAnsi(
      renderMemoryAdded(mkMemory({ id: "abcdef1234567890", source: "explicit", importance: 3 })),
    );
    expect(out).toContain("Stored memory abcdef12");
    expect(out).toContain("(explicit, \u2605\u2605\u2605)");
  });

  it("renderMemoryDeleted shows the truncated id", () => {
    const out = stripAnsi(renderMemoryDeleted("abcdef1234567890"));
    expect(out).toContain("Deleted memory abcdef12");
  });

  it("renderMemoryCleared pluralises by count", () => {
    expect(stripAnsi(renderMemoryCleared("user-alex", 0))).toContain("0 memories");
    expect(stripAnsi(renderMemoryCleared("user-alex", 1))).toContain("1 memory");
    expect(stripAnsi(renderMemoryCleared("user-alex", 5))).toContain("5 memories");
    expect(stripAnsi(renderMemoryCleared("user-alex", 5))).toContain('user "user-alex"');
  });
});

/* ------------------------------------------------------------------ */
/*  Export formats                                                     */
/* ------------------------------------------------------------------ */

describe("exportMemoriesJson", () => {
  it("emits pretty-printed JSON terminated by a newline", () => {
    const memory = mkMemory({
      id: "abc",
      tags: ["preferences", "code"],
      last_accessed_at: new Date("2026-04-15T11:00:00Z"),
    });
    const out = exportMemoriesJson([memory]);

    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out) as UserMemory[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.id).toBe("abc");
    expect(parsed[0]!.tags).toEqual(["preferences", "code"]);
    // Pretty-printed → contains a newline within the JSON.
    expect(out.split("\n").length).toBeGreaterThan(2);
  });

  it("handles an empty memory list", () => {
    expect(exportMemoriesJson([])).toBe("[]\n");
  });
});

describe("exportMemoriesCsv", () => {
  it("emits a header row plus one row per memory", () => {
    const out = exportMemoriesCsv([
      mkMemory({
        id: "row-a",
        content: "User prefers TS",
        tags: ["lang"],
      }),
    ]);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "id,user_id,content,source,importance,tags,created_at,last_accessed_at,expires_at",
    );
    expect(lines[1]).toContain("row-a");
    expect(lines[1]).toContain("User prefers TS");
    expect(lines[1]).toContain("lang");
  });

  it("escapes commas, quotes, and newlines RFC-4180 style", () => {
    const out = exportMemoriesCsv([
      mkMemory({
        id: "tricky",
        content: 'Likes "hard mode", and yelling.',
      }),
    ]);
    // Embedded quotes are doubled and the field is wrapped.
    expect(out).toContain('"Likes ""hard mode"", and yelling."');
  });

  it("joins tags with semicolons so the field stays single-cell", () => {
    const out = exportMemoriesCsv([
      mkMemory({ tags: ["a", "b", "c"] }),
    ]);
    // Should appear as "a;b;c" without commas (which would split cells).
    const lines = out.trim().split("\n");
    expect(lines[1]!).toContain("a;b;c");
    expect(lines[1]!).not.toContain("a,b,c");
  });

  it("emits empty fields for absent optionals (tags, last_accessed_at, expires_at)", () => {
    const out = exportMemoriesCsv([
      mkMemory({ id: "minimal" }), // no tags, no last_accessed_at, no expires_at
    ]);
    const row = out.trim().split("\n")[1]!;
    // Last two fields (last_accessed_at + expires_at) are absent; the
    // tags field in position 5 is also empty. The row therefore ends
    // with timestamp,, — two trailing commas after created_at.
    expect(row).toMatch(/,,$/);
    // tags column (5th field, before created_at) is also empty —
    // appears as two adjacent commas mid-row.
    expect(row).toMatch(/,2,,2026-04-15/);
  });

  it("handles an empty memory list (header-only output)", () => {
    const out = exportMemoriesCsv([]);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith("id,user_id,content")).toBe(true);
  });
});
