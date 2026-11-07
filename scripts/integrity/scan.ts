import { Buffer } from "node:buffer";
import { FILE_SIZE_LIMIT, LINE_RULES } from "./rules.js";
import type { Finding } from "./types.js";

/**
 * Applies every rule to the text of one config file. Pure: it reads and prints nothing.
 *
 * Lines are split on CRLF, LF and a lone CR, so a payload cannot sit behind a carriage return
 * that a terminal draws as a line break. Comments are scanned like code.
 *
 * @param path - The path to name in each finding, relative to the repository root.
 * @param text - The file's content, decoded as UTF-8.
 * @returns Every finding: the file-size finding first, then the line findings in line order.
 */
export function scanText(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const size = Buffer.byteLength(text, "utf8");
  if (size > FILE_SIZE_LIMIT) findings.push({ path, line: null, rule: "FILE_SIZE", length: size });
  text.split(/\r\n|\n|\r/).forEach((line, index) => {
    for (const rule of LINE_RULES) {
      if (rule.test(line)) findings.push({ path, line: index + 1, rule: rule.id, length: line.length });
    }
  });
  return findings;
}
