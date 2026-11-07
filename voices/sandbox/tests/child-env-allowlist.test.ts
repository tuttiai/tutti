/**
 * Sandbox code sees only the allowlisted variables of the agent's
 * environment, and those are read through `SecretsManager` (tutti#28).
 *
 * The allowlist is copied here on purpose: widening the one in
 * `src/utils/child-env.ts` must fail this test until someone has looked at
 * what the new variable could carry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsManager } from "@tuttiai/core";

import { childEnv } from "../src/utils/child-env.js";
import { execute } from "../src/executor.js";

const ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
];

/** Variables bash itself exports into every shell. */
const BASH_OWN = ["PWD", "OLDPWD", "SHLVL", "_"];

/** Fake credentials, one per redacted format, assembled so none is committed whole. */
const SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk" + "-ant-api03-" + "x1Y2".repeat(6),
  CLAUDE_CODE_OAUTH_TOKEN: "sk" + "-ant-oat01-" + "x1Y2".repeat(6),
  OPENAI_API_KEY: "sk" + "-" + "x1Y2".repeat(6),
  GITHUB_TOKEN: "gh" + "p_" + "x1Y2".repeat(9),
  GOOGLE_API_KEY: "AI" + "za" + "x1Y2z".repeat(7),
  AUTH_HEADER: "Bea" + "rer " + "x1Y2".repeat(6),
  TUTTI_VOICES: '[{"voice":"github","options":{"token":"' + "gh" + "p_" + "z9".repeat(18) + '"}}]',
  NODE_ENV: "production",
};

function stubSecrets(): void {
  for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("childEnv reads through SecretsManager", () => {
  it("asks SecretsManager.optional for each allowlisted name exactly once", () => {
    const spy = vi.spyOn(SecretsManager, "optional");
    stubSecrets();

    childEnv();

    const asked = spy.mock.calls.map(([name]) => name);
    expect([...asked].sort()).toEqual([...ALLOWLIST].sort());
  });

  it("never asks for a credential's name", () => {
    const spy = vi.spyOn(SecretsManager, "optional");

    childEnv();

    const asked = new Set(spy.mock.calls.map(([name]) => name));
    for (const name of Object.keys(SECRETS)) expect(asked.has(name)).toBe(false);
  });

  it("takes each value from SecretsManager, not from the environment", () => {
    vi.stubEnv("PATH", "/from/process/env");
    vi.spyOn(SecretsManager, "optional").mockImplementation((name) =>
      name === "PATH" ? "/from/secrets-manager" : undefined,
    );

    expect(childEnv()).toEqual({ PATH: "/from/secrets-manager" });
  });
});

describe("childEnv edge cases", () => {
  it("does not inherit names that only resemble an allowlisted one", () => {
    vi.stubEnv("path", "/lower");
    vi.stubEnv("PATH_EXTRA", "/extra");
    vi.stubEnv("HOMEDIR", "/home/x");

    const env = childEnv();

    expect(env).not.toHaveProperty("path");
    expect(env).not.toHaveProperty("PATH_EXTRA");
    expect(env).not.toHaveProperty("HOMEDIR");
  });

  it("keeps an allowlisted variable set to the empty string", () => {
    vi.stubEnv("LANG", "");

    expect(childEnv().LANG).toBe("");
  });

  it("returns a fresh object each time, never process.env", () => {
    const first = childEnv();
    first.INJECTED = "1";

    expect(childEnv()).not.toHaveProperty("INJECTED");
  });
});

describe("execute: what sandbox code can see", () => {
  it("exports only allowlisted variables to a snippet", async () => {
    stubSecrets();
    vi.stubEnv("TZ", "Europe/Amsterdam");

    const r = await execute("compgen -e", "bash");

    const names = r.stdout.split("\n").filter((n) => n !== "" && !BASH_OWN.includes(n));
    expect(names).toContain("TZ");
    for (const name of names) expect(ALLOWLIST).toContain(name);
  });

  it("shows an allowlisted value and no credential value", async () => {
    stubSecrets();
    vi.stubEnv("TZ", "Europe/Amsterdam");

    const r = await execute("echo \"[$TZ]\"; env", "bash");

    expect(r.stdout).toContain("[Europe/Amsterdam]");
    for (const value of Object.values(SECRETS)) expect(r.stdout).not.toContain(value);
  });

  it("reads each credential as unset inside the snippet", async () => {
    stubSecrets();
    const names = Object.keys(SECRETS);
    const code = names.map((n) => `echo "${n}=\${${n}-unset}"`).join("; ");

    const r = await execute(code, "bash");

    expect(r.stdout.trim().split("\n")).toEqual(names.map((n) => `${n}=unset`));
  });

  it("leaves an unset allowlisted variable missing, not the text undefined", async () => {
    vi.stubEnv("HTTPS_PROXY", undefined);

    const r = await execute('echo "[${HTTPS_PROXY-missing}]"', "bash");

    expect(r.stdout.trim()).toBe("[missing]");
  });

  it("lets the voice's env option override and extend the allowlist", async () => {
    vi.stubEnv("TZ", "UTC");

    const r = await execute('echo "[$TZ][$CI]"', "bash", { env: { TZ: "Asia/Tokyo", CI: "1" } });

    expect(r.stdout.trim()).toBe("[Asia/Tokyo][1]");
  });
});
