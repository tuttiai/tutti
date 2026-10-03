import { SecretsManager } from "@tuttiai/core";

/**
 * The only variables a sandboxed process inherits from the agent's own.
 *
 * Enough to find binaries, write a cache under `HOME`, keep the locale and
 * reach the network through a proxy or a private CA. Everything else is left
 * behind because the agent's environment holds its credentials: the model
 * login, and every voice's token inside `TUTTI_VOICES`. A snippet given those
 * could print them into the conversation without meaning to.
 *
 * This is not isolation. The child runs as the server's own user, so code
 * that sets out to can still read them from `/proc/1/environ`. Only a
 * container that holds no credential is safe to give `shell`.
 *
 * `NODE_ENV` is left behind too. The server image sets it to `production`,
 * which makes `npm ci` skip devDependencies and so breaks every build and
 * test run started from the sandbox.
 */
const INHERITED = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
] as const;

/**
 * Build the environment for a sandboxed child process: the allowlisted
 * variables of this process, then `extra` on top.
 *
 * @param extra - Variables the voice was configured with. They win over inherited ones.
 * @returns A fresh environment object, never `process.env` itself.
 *
 * @example
 * spawn("/bin/bash", ["-c", code], { env: childEnv({ CI: "1" }) });
 */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inherited = INHERITED.flatMap<[string, string]>((key) => {
    const value = SecretsManager.optional(key);
    return value === undefined ? [] : [[key, value]];
  });
  return { ...Object.fromEntries(inherited), ...extra };
}
