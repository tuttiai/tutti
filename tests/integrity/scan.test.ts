import { describe, expect, it } from "vitest";
import { FILE_SIZE_LIMIT } from "../../scripts/integrity/rules.js";
import { scanText } from "../../scripts/integrity/scan.js";

const CHILD = "child_" + "process";
const EVAL = "ev" + "al";

const CLEAN_CONFIG = [
  `import { defineConfig } from "vitest/config";`,
  "",
  "export default defineConfig({",
  `  test: { environment: "node", include: ["tests/**/*.test.ts"] },`,
  "});",
  "",
].join("\n");

describe("scanText", () => {
  it("passes a clean config", () => {
    expect(scanText("vitest.config.ts", CLEAN_CONFIG)).toEqual([]);
  });

  it("reports every hit in a file with its line and length", () => {
    const one = `import cp from "${CHILD}";`;
    const two = `const v = ${EVAL}("1");`;
    const text = ["// ok", one, "", two].join("\n");
    expect(scanText("eslint.config.js", text)).toEqual([
      { path: "eslint.config.js", line: 2, rule: "CHILD_PROCESS", length: one.length },
      { path: "eslint.config.js", line: 4, rule: "DYNAMIC_CODE", length: two.length },
    ]);
  });

  it("reports every rule a single padded payload line breaks", () => {
    const payload = `export default c;${" ".repeat(400)}${EVAL}(Buffer.from(b, "hex").toString());`;
    const rules = scanText("eslint.config.js", payload).map((finding) => finding.rule);
    expect(rules).toEqual(["LONG_LINE", "WHITESPACE_PAD", "DYNAMIC_CODE", "DECODE"]);
  });

  it("splits on CRLF and on a lone CR, so a carriage return hides nothing", () => {
    const text = `const a = 1;\r\nconst b = 2;\rconst v = ${EVAL}("1");`;
    expect(scanText("x.config.js", text)).toEqual([
      { path: "x.config.js", line: 3, rule: "DYNAMIC_CODE", length: 20 },
    ]);
  });

  it("scans comments like code", () => {
    const text = `// ${CHILD}`;
    expect(scanText("x.config.js", text).map((finding) => finding.rule)).toEqual(["CHILD_PROCESS"]);
  });

  it("reports FILE_SIZE in bytes with no line, before the line findings", () => {
    const text = `${"a\n".repeat(4200)}const v = ${EVAL}("1");`;
    const findings = scanText("x.config.js", text);
    expect(findings[0]).toEqual({
      path: "x.config.js",
      line: null,
      rule: "FILE_SIZE",
      length: Buffer.byteLength(text, "utf8"),
    });
    expect(findings[1]?.rule).toBe("DYNAMIC_CODE");
  });

  it("allows a file of exactly the size limit", () => {
    expect(scanText("x.config.js", "a\n".repeat(FILE_SIZE_LIMIT / 2))).toEqual([]);
  });

  it("counts multi-byte characters by their UTF-8 bytes", () => {
    const text = "é\n".repeat(2731);
    expect(text.length).toBeLessThan(FILE_SIZE_LIMIT);
    expect(scanText("x.config.js", text)).toEqual([
      { path: "x.config.js", line: null, rule: "FILE_SIZE", length: 8193 },
    ]);
  });
});
