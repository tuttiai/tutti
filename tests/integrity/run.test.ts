import { describe, expect, it } from "vitest";
import type { IntegrityFs } from "../../scripts/integrity/discover.js";
import { EXIT_CLEAN, EXIT_FINDINGS, EXIT_INCOMPLETE, run } from "../../scripts/integrity/run.js";
import { ROOT, captureWriter, fakeFs } from "./fake-fs.js";
import type { FakeTree } from "./fake-fs.js";

// Dangerous tokens are assembled at run time, so this file never reads as a dropper itself.
const CHILD_LINE = `import cp from "node:${"child_" + "process"}";`;
const EVAL_LINE = `const v = ${"ev" + "al"}("1");`;
const NET_LINE = `import https from "node:https";`;
const CLEAN = `import { defineConfig } from "vitest/config";\nexport default defineConfig({});\n`;

async function runOn(tree: FakeTree): Promise<{ code: number; out: string[]; err: string[] }> {
  const { write, out, err } = captureWriter();
  const code = await run({ root: ROOT, fs: fakeFs(tree), write });
  return { code, out, err };
}

describe("run", () => {
  it("exits 0 and says so on stdout when every config is clean", async () => {
    const result = await runOn({
      files: { "eslint.config.js": CLEAN, "packages/web/vite.config.ts": CLEAN, "packages/web/src/main.ts": EVAL_LINE },
    });
    expect(result).toEqual({
      code: EXIT_CLEAN,
      out: ["check:integrity: OK, 2 config files scanned, 0 findings"],
      err: [],
    });
  });

  it("exits 1 and reports every finding across files, sorted, then the summary", async () => {
    const result = await runOn({
      files: {
        "voices/db/vitest.config.ts": `// ok\n${EVAL_LINE}`,
        "packages/web/vite.config.ts": `${CHILD_LINE}\n${NET_LINE}`,
        "eslint.config.js": CLEAN,
      },
    });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.out).toEqual([]);
    expect(result.err).toEqual([
      `packages/web/vite.config.ts:1 CHILD_PROCESS len=${String(CHILD_LINE.length)}`,
      `packages/web/vite.config.ts:2 NETWORK len=${String(NET_LINE.length)}`,
      `voices/db/vitest.config.ts:2 DYNAMIC_CODE len=${String(EVAL_LINE.length)}`,
      "check:integrity: 3 finding(s) in 2 of 3 config files",
    ]);
  });

  it("exits 2 when there are no config files, so a scan of nothing never passes", async () => {
    const result = await runOn({ files: { "README.md": "" } });
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err).toEqual(["check:integrity: no config files found, so nothing was checked"]);
  });

  it("exits 2 on an unreadable file, naming it and its error code, and scans the rest", async () => {
    const result = await runOn({
      files: { "eslint.config.js": "", "voices/db/vitest.config.ts": CLEAN },
      unreadable: ["eslint.config.js"],
    });
    expect(result.code).toBe(EXIT_INCOMPLETE);
    expect(result.err).toEqual([
      "eslint.config.js: could not be read (EACCES)",
      "check:integrity: 1 of 2 config files could not be read",
    ]);
  });

  it("exits 1 when there are findings as well as an unreadable file", async () => {
    const result = await runOn({
      files: { "eslint.config.js": "", "voices/db/vitest.config.ts": EVAL_LINE },
      unreadable: ["eslint.config.js"],
    });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err.at(-1)).toBe("check:integrity: 1 finding(s) in 1 of 2 config files");
  });

  it("reports a symlinked config without reading it", async () => {
    const result = await runOn({ files: { "eslint.config.js": CLEAN }, symlinks: ["vite.config.ts"] });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err).toEqual([
      "vite.config.ts:- SYMLINK len=0",
      "check:integrity: 1 finding(s) in 1 of 2 config files",
    ]);
  });

  it("reports a symlinked workspace directory and exits 1, so its configs cannot hide", async () => {
    const result = await runOn({ files: { "eslint.config.js": CLEAN }, symlinks: ["packages/web"] });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err).toEqual([
      "packages/web:- SYMLINK len=0",
      "check:integrity: 1 finding(s) in 1 of 2 config files",
    ]);
  });

  it("never prints a control character from a file name, in a finding or a read error", async () => {
    const hostile = "evil\u001b[2K\r.config.js";
    const unreadable = "gone\u001b[1A.config.js";
    const result = await runOn({
      files: { [hostile]: EVAL_LINE, [unreadable]: "" },
      unreadable: [unreadable],
    });
    expect(result.code).toBe(EXIT_FINDINGS);
    expect(result.err).toEqual([
      String.raw`gone\u{1b}[1A.config.js: could not be read (EACCES)`,
      String.raw`evil\u{1b}[2K\u{d}.config.js:1 DYNAMIC_CODE len=` + String(EVAL_LINE.length),
      "check:integrity: 1 finding(s) in 1 of 2 config files",
    ]);
    const printed = [...result.out, ...result.err].join("\n");
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("\r");
  });

  it("names a read error by its message when it has no code", async () => {
    const { write, err } = captureWriter();
    const base = fakeFs({ files: { "eslint.config.js": CLEAN } });
    const fs: IntegrityFs = { ...base, readFile: () => Promise.reject(new Error("disk gone")) };
    expect(await run({ root: ROOT, fs, write })).toBe(EXIT_INCOMPLETE);
    expect(err[0]).toBe("eslint.config.js: could not be read (disk gone)");
  });

  it("names a read error that is not an Error as unknown", async () => {
    const { write, err } = captureWriter();
    const base = fakeFs({ files: { "eslint.config.js": CLEAN } });
    const thrown: unknown = 42;
    const fs: IntegrityFs = {
      ...base,
      readFile: () => {
        throw thrown;
      },
    };
    expect(await run({ root: ROOT, fs, write })).toBe(EXIT_INCOMPLETE);
    expect(err[0]).toBe("eslint.config.js: could not be read (unknown error)");
  });

  it("never prints file content, even for a padded payload with escape sequences", async () => {
    const marker = "PAYLOAD_MARKER";
    const payload = `export default c;${" ".repeat(500)}\u001b]0;${marker}\u0007${EVAL_LINE}`;
    const result = await runOn({ files: { "eslint.config.js": payload } });
    expect(result.code).toBe(EXIT_FINDINGS);
    const printed = [...result.out, ...result.err].join("\n");
    expect(printed).not.toContain(marker);
    expect(printed).not.toContain("\u001b");
    expect(printed).not.toContain("ev" + "al");
  });
});
