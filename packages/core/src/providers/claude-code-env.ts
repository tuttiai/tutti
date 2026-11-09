import { SecretsManager } from "../secrets.js";

/**
 * The only variables the Claude Code CLI inherits from the server's own
 * environment. Exact names only: a prefix such as `LC_*` would mean walking
 * every variable the server holds.
 *
 * Enough to find binaries, keep the locale, reach the network through a proxy
 * or a private CA, and sign the CLI in: its config directory and the login
 * variables it reads instead of a file. Everything else stays behind, because
 * the server's environment holds credentials the CLI has no use for, such as
 * `TUTTI_PG_URL`, other providers' keys and the voices' tokens.
 *
 * The list differs on purpose from the sandbox voice's (`voices/sandbox`):
 * the CLI needs its login variables, which sandboxed code must never see.
 * `NODE_OPTIONS` is left behind because `--require` injects code into the
 * child, and `NODE_ENV` because the CLI has no use for it.
 *
 * This is not isolation. The child runs as the server's own user, and the
 * login variables above still reach it, so use a key limited to this purpose.
 */
export const INHERITED = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TERM",
  "LANG", "LANGUAGE", "TZ", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC",
  "LC_TIME", "LC_COLLATE", "LC_MONETARY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
] as const;

/**
 * Build the environment for one Claude Code CLI run: the allowlisted
 * variables of this process, read through `SecretsManager`, then `extra` on
 * top. A variable that is not set is left out rather than set empty.
 *
 * @param extra - Variables for this run. They win over inherited ones and may add names not on the list.
 * @returns A fresh environment object, never `process.env` itself.
 */
export function claudeCodeEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const inherited = INHERITED.flatMap<[string, string]>((key) => {
    const value = SecretsManager.optional(key);
    return value === undefined ? [] : [[key, value]];
  });
  return { ...Object.fromEntries(inherited), ...extra };
}
