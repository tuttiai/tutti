import { describe, expect, it } from "vitest";
import { LINE_RULES, LONG_LINE_LIMIT } from "../../scripts/integrity/rules.js";
import type { RuleId } from "../../scripts/integrity/types.js";

// Dangerous tokens are assembled at run time, so this file never reads as a dropper itself.
const CHILD = "child_" + "process";
const EVAL = "ev" + "al";
const FUNC = "Func" + "tion";

function rulesHit(line: string): RuleId[] {
  return LINE_RULES.filter((rule) => rule.test(line)).map((rule) => rule.id);
}

const SINGLE_HITS: readonly (readonly [RuleId, string])[] = [
  ["LONG_LINE", `const s = "${"ab ".repeat(110)}";`],
  ["WHITESPACE_PAD", `export default config;${" ".repeat(60)}run();`],
  ["WHITESPACE_PAD", `export default config;${"\t".repeat(60)}run();`],
  ["DYNAMIC_CODE", `const v = ${EVAL}("1 + 1");`],
  ["DYNAMIC_CODE", `const f = new ${FUNC}("return 1");`],
  ["DYNAMIC_CODE", `const g = ${FUNC}("return 1")();`],
  ["DYNAMIC_CODE", `import vm from "node:vm";`],
  ["CHILD_PROCESS", `import cp from "node:${CHILD}";`],
  ["CHILD_PROCESS", `cp.${"exec" + "Sync"}("ls");`],
  ["CHILD_PROCESS", `cp.${"spa" + "wn"}("ls");`],
  ["NETWORK", `import https from "node:https";`],
  ["NETWORK", `const sock = require("net");`],
  ["NETWORK", `const r = ${"fet" + "ch"}("https://example.invalid");`],
  ["NETWORK", `const w = new ${"Web" + "Socket"}(url);`],
  ["FS_WRITE", `fs.${"writeFile" + "Sync"}(target, data);`],
  ["FS_WRITE", `await ${"chm" + "od"}(target, 0o755);`],
  ["SENSITIVE_PATH", `const p = join(${"home" + "dir"}(), "notes");`],
  ["SENSITIVE_PATH", `const p = "~/${".s" + "sh"}/config";`],
  ["SENSITIVE_PATH", `const p = "~/${".np" + "mrc"}";`],
  ["ENCODED_BLOB", `const b = "${"QUJD".repeat(30)}";`],
  ["ENCODED_BLOB", `const h = "${"0f".repeat(32)}";`],
  ["DECODE", `const t = Buffer.from(blob, "${"base" + "64"}").toString();`],
  ["DECODE", `const t = Buffer.from(blob, 'hex');`],
  ["DECODE", `const t = ${"at" + "ob"}(blob);`],
  ["CHARCODE", `const c = String.${"fromChar" + "Code"}(72, 105);`],
  ["DYNAMIC_LOAD", `const m = await import(name);`],
  ["DYNAMIC_LOAD", `const m = require("./" + name);`],
  ["DYNAMIC_LOAD", "const m = require(`./${name}`);"],
  ["DYNAMIC_LOAD", `const req = ${"create" + "Require"}(import.meta.url);`],
  ["OBFUSCATED_IDENT", `var _0x4f2a = [];`],
];

const CLEAN_LINES: readonly string[] = [
  // Line 51 of the clean eslint.config.js: a character class, not a run of hex digits.
  String.raw`          "Literal[value=/(?:text|bg|border|fill|stroke|ring)-\\[#[0-9a-fA-F]{3,8}\\]/]",`,
  `import { defineConfig } from "vitest/config";`,
  `import react from "@vitejs/plugin-react";`,
  `const local = await import("./local.js");`,
  `const { name } = require("./package.json", { with: { type: "json" } });`,
  `const total = myFunction(1) + obj.Function(2);`,
  `const colour = "#1a2b3c";`,
  `const h = "${"0f".repeat(31)}a";`,
  `const b = "${"QUJD".repeat(29)}QUJ";`,
  `export default { server: { port: 5173, proxy: { "/api": { target, ws: true } } } };`,
  `const renamed = { renameTo: "x" };`,
  "a b ".repeat(LONG_LINE_LIMIT / 4),
  `${" ".repeat(80)}indented(); // leading indentation is not padding`,
  "",
];

describe("LINE_RULES", () => {
  it("has one entry per line rule, each with a description", () => {
    const ids = LINE_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(12);
    expect(LINE_RULES.every((rule) => rule.description.length > 0)).toBe(true);
  });

  it.each(SINGLE_HITS)("%s fires alone on its sample", (id, line) => {
    expect(rulesHit(line)).toEqual([id]);
  });

  it.each(CLEAN_LINES)("leaves a clean line alone: %s", (line) => {
    expect(rulesHit(line)).toEqual([]);
  });

  it("measures LONG_LINE in UTF-16 code units, not characters", () => {
    const emoji = "\u{1F600}".repeat(151);
    expect(emoji.length).toBe(302);
    expect(rulesHit(emoji)).toEqual(["LONG_LINE"]);
  });

  it("allows exactly the limit and fails one over it", () => {
    const atLimit = "a b ".repeat(LONG_LINE_LIMIT / 4);
    expect(rulesHit(atLimit)).toEqual([]);
    expect(rulesHit(`${atLimit}c`)).toEqual(["LONG_LINE"]);
  });

  it("returns quickly on a long hostile line", () => {
    const hostile = `Buffer.from(${"(".repeat(20000)}`;
    const started = performance.now();
    rulesHit(hostile);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
