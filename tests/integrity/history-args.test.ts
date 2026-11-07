import { describe, expect, it } from "vitest";
import { isCalendarDate, isSafeRef, parseHistoryArgs } from "../../scripts/integrity/history-args.js";

describe("isCalendarDate", () => {
  it("accepts a real day", () => {
    expect(isCalendarDate("2026-10-30")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true);
  });

  it("refuses a day that does not exist, though it has the right shape", () => {
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2027-02-29")).toBe(false);
  });

  it("refuses any other shape, including git's own date words and a trailing option", () => {
    for (const text of ["", "2026-1-30", "30-10-2026", "yesterday", "2026-10-30 --all", "2026-10-30\n"]) {
      expect(isCalendarDate(text)).toBe(false);
    }
  });
});

describe("isSafeRef", () => {
  it("accepts branch names", () => {
    expect(isSafeRef("main")).toBe(true);
    expect(isSafeRef("origin/feat/x-1.2_b")).toBe(true);
  });

  it("refuses a leading dash, so a ref is never read as an option", () => {
    expect(isSafeRef("--output=/tmp/x")).toBe(false);
    expect(isSafeRef("-p")).toBe(false);
  });

  it("refuses spaces, revision syntax and control characters", () => {
    for (const text of ["", "main branch", "main^{tree}", "main~1", "main@{1}", "main\u001b[2J", "a:b"]) {
      expect(isSafeRef(text)).toBe(false);
    }
  });
});

describe("parseHistoryArgs", () => {
  it("defaults to every merge on main", () => {
    expect(parseHistoryArgs([])).toEqual({ ok: true, args: { since: null, ref: "main" } });
  });

  it("takes --since and --ref in either form", () => {
    expect(parseHistoryArgs(["--since=2026-10-01", "--ref", "origin/main"])).toEqual({
      ok: true,
      args: { since: "2026-10-01", ref: "origin/main" },
    });
  });

  it("refuses a bad --since without echoing it", () => {
    const parsed = parseHistoryArgs(["--since=2026-02-30"]);
    expect(parsed).toEqual({ ok: false, reason: "--since must be a real date as YYYY-MM-DD" });
  });

  it("refuses a bad --ref without echoing it", () => {
    const parsed = parseHistoryArgs(["--ref=-x\u001b]0;pwned\u0007"]);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("pwned");
  });

  it("refuses an unknown option, a stray argument and a value-less --since", () => {
    for (const argv of [["--all"], ["main"], ["--since"]]) {
      expect(parseHistoryArgs(argv)).toEqual({ ok: false, reason: "unknown option or stray argument" });
    }
  });
});
