import type { LineRule } from "./types.js";

/** A line longer than this many UTF-16 code units is reported as `LONG_LINE`. */
export const LONG_LINE_LIMIT = 300;

/**
 * A file larger than this many bytes is reported as `FILE_SIZE`. The dropper found in
 * eslint.config.js was 9,302 bytes; the clean file is 2,444.
 */
export const FILE_SIZE_LIMIT = 8192;

const SPECIFIER = /\b(?:require\s*\(|import\s*\(|from|import)\s*["']([^"']+)["']/g;
const VM_MODULES: ReadonlySet<string> = new Set(["vm"]);
const NETWORK_MODULES: ReadonlySet<string> = new Set(["http", "https", "http2", "net", "tls", "dgram", "dns"]);

/** True when the line imports or requires any of the named Node modules, with or without `node:`. */
function importsAny(line: string, names: ReadonlySet<string>): boolean {
  return [...line.matchAll(SPECIFIER)].some((match) => names.has((match[1] ?? "").replace(/^node:/, "")));
}

/**
 * Every rule applied to each line of a config file. Regex literals only, none with a nested
 * quantifier, so a hostile line cannot make a rule backtrack catastrophically. There is no
 * allowlist and no suppression comment: a bypass would be the attacker's bypass too.
 */
export const LINE_RULES: readonly LineRule[] = [
  {
    id: "LONG_LINE",
    description: "A line too long to read in an editor or a diff, where a payload hides.",
    test: (line) => line.length > LONG_LINE_LIMIT,
  },
  {
    id: "WHITESPACE_PAD",
    description: "60 or more blanks after code, pushing what follows off the right edge.",
    test: (line) => /\S[ \t]{60,}/.test(line),
  },
  {
    id: "DYNAMIC_CODE",
    description: "eval, Function or the vm module: code built from a string.",
    test: (line) => /\beval\s*\(|(?<![\w$.])Function\s*\(/.test(line) || importsAny(line, VM_MODULES),
  },
  {
    id: "CHILD_PROCESS",
    description: "Starting another process, which a config file never needs.",
    test: (line) =>
      /child_process|\b(?:execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/.test(line),
  },
  {
    id: "NETWORK",
    description: "A network call or a network module, used to fetch or exfiltrate.",
    test: (line) =>
      /\bfetch\s*\(|XMLHttpRequest|WebSocket/.test(line) || importsAny(line, NETWORK_MODULES),
  },
  {
    id: "FS_WRITE",
    description: "Writing, copying, renaming or changing the mode of a file.",
    test: (line) =>
      /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|chmod|chmodSync|copyFile|copyFileSync|rename|renameSync)\b/.test(
        line,
      ),
  },
  {
    id: "SENSITIVE_PATH",
    description: "The home directory or a credential store.",
    test: (line) => /\bhomedir\s*\(|\.ssh\b|\.npmrc|\.aws\b|\.gnupg|\bid_rsa|\.git-credentials/.test(line),
  },
  {
    id: "ENCODED_BLOB",
    description: "An unbroken run of 120 or more base64 characters or 64 or more hex digits.",
    test: (line) => /[A-Za-z0-9+/=]{120,}|[0-9a-fA-F]{64,}/.test(line),
  },
  {
    id: "DECODE",
    description: "Decoding base64 or hex at load time.",
    test: (line) => /\bBuffer\.from\s*\(.*["'](?:base64|base64url|hex)["']|\batob\s*\(/.test(line),
  },
  {
    id: "CHARCODE",
    description: "Assembling a string from character codes.",
    test: (line) => /\bString\.fromCharCode\b/.test(line),
  },
  {
    id: "DYNAMIC_LOAD",
    description: "require, import or createRequire with anything but one plain string literal.",
    test: (line) =>
      /\b(?:require|import)\s*\(\s*(?!["'][^"'\n]*["']\s*[,)])|\bcreateRequire\b/.test(line),
  },
  {
    id: "OBFUSCATED_IDENT",
    description: "The _0x identifiers javascript-obfuscator emits.",
    test: (line) => /_0x[0-9a-fA-F]{4,}/.test(line),
  },
];
