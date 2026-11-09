/**
 * The Claude Code CLI inherits only the allowlisted variables of the server's
 * environment, read through `SecretsManager`, plus the run's own additions.
 *
 * The allowlist is copied here on purpose: widening the one in
 * `src/providers/claude-code-env.ts` must fail this test until someone has
 * looked at what the new variable could carry.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeCodeEnv } from "../src/providers/claude-code-env.js";
import { SecretsManager } from "../src/secrets.js";

const ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "TERM",
  "LANG", "LANGUAGE", "TZ", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_NUMERIC",
  "LC_TIME", "LC_COLLATE", "LC_MONETARY",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
];

/** Server credentials the CLI must never see, assembled so none is committed whole. */
const SECRETS: Record<string, string> = {
  TUTTI_PG_URL: "postgres://tutti:" + "pw-" + "x1Y2".repeat(4) + "@db:5432/tutti",
  OPENAI_API_KEY: "sk" + "-" + "x1Y2".repeat(6),
  GITHUB_TOKEN: "gh" + "p_" + "x1Y2".repeat(9),
  AWS_SECRET_ACCESS_KEY: "aws-" + "x1Y2".repeat(8),
  TUTTI_VOICES: '[{"voice":"github","options":{"token":"' + "gh" + "p_" + "z9".repeat(18) + '"}}]',
  NODE_OPTIONS: "--require /tmp/evil.js",
};

/** The CLI's own login, which must still reach it. */
const LOGIN: Record<string, string> = {
  HOME: "/home/tutti",
  CLAUDE_CONFIG_DIR: "/state/claude",
  CLAUDE_CODE_OAUTH_TOKEN: "sk" + "-ant-oat01-" + "x1Y2".repeat(6),
  ANTHROPIC_API_KEY: "sk" + "-ant-api03-" + "x1Y2".repeat(6),
};

function stubAll(values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("claudeCodeEnv reads through SecretsManager", () => {
  it("asks SecretsManager.optional for each allowlisted name exactly once", () => {
    const spy = vi.spyOn(SecretsManager, "optional");
    stubAll(SECRETS);

    claudeCodeEnv();

    const asked = spy.mock.calls.map(([name]) => name);
    expect([...asked].sort()).toEqual([...ALLOWLIST].sort());
  });

  it("never asks for a server credential's name", () => {
    const spy = vi.spyOn(SecretsManager, "optional");

    claudeCodeEnv();

    const asked = new Set(spy.mock.calls.map(([name]) => name));
    for (const name of Object.keys(SECRETS)) expect(asked.has(name)).toBe(false);
  });

  it("takes each value from SecretsManager, not from the environment", () => {
    vi.stubEnv("PATH", "/from/process/env");
    vi.spyOn(SecretsManager, "optional").mockImplementation((name) =>
      name === "PATH" ? "/from/secrets-manager" : undefined,
    );

    expect(claudeCodeEnv()).toEqual({ PATH: "/from/secrets-manager" });
  });
});

describe("claudeCodeEnv keeps server secrets out", () => {
  it("leaves out TUTTI_PG_URL and OPENAI_API_KEY set in the parent", () => {
    stubAll(SECRETS);

    const env = claudeCodeEnv();

    expect(env).not.toHaveProperty("TUTTI_PG_URL");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("leaves out NODE_OPTIONS, AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN and TUTTI_VOICES", () => {
    stubAll(SECRETS);

    const env = claudeCodeEnv({ CLAUDE_CONFIG_DIR: "/state/claude" });

    for (const name of Object.keys(SECRETS)) expect(env).not.toHaveProperty(name);
    for (const value of Object.values(SECRETS)) expect(Object.values(env)).not.toContain(value);
  });
});

describe("claudeCodeEnv keeps what the CLI needs", () => {
  it("passes the CLI's login and config through, so it still finds its login", () => {
    stubAll({ ...SECRETS, ...LOGIN });

    expect(claudeCodeEnv()).toMatchObject(LOGIN);
  });

  it("lets the run's variables win over inherited ones", () => {
    stubAll(LOGIN);

    const env = claudeCodeEnv({ HOME: "/run/home", CLAUDE_CONFIG_DIR: "/run/claude" });

    expect(env).toMatchObject({ HOME: "/run/home", CLAUDE_CONFIG_DIR: "/run/claude" });
  });

  it("adds a run variable that is not on the allowlist", () => {
    expect(claudeCodeEnv({ DISABLE_TELEMETRY: "1" })).toMatchObject({ DISABLE_TELEMETRY: "1" });
  });
});

describe("claudeCodeEnv edge cases", () => {
  it("leaves an unset allowlisted name out rather than adding it empty", () => {
    vi.stubEnv("HTTPS_PROXY", undefined);

    expect(claudeCodeEnv()).not.toHaveProperty("HTTPS_PROXY");
  });

  it("does not inherit names that only resemble an allowlisted one", () => {
    vi.stubEnv("PATH_EXTRA", "/extra");
    vi.stubEnv("HOMEDIR", "/home/x");
    vi.stubEnv("LC_SECRET", "x");
    vi.stubEnv("ANTHROPIC_VERTEX_PROJECT_ID", "proj");

    const env = claudeCodeEnv();

    for (const name of ["PATH_EXTRA", "HOMEDIR", "LC_SECRET", "ANTHROPIC_VERTEX_PROJECT_ID"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("keeps an allowlisted variable set to the empty string", () => {
    vi.stubEnv("LANG", "");

    expect(claudeCodeEnv().LANG).toBe("");
  });

  it("returns a fresh object each time, never process.env", () => {
    const first = claudeCodeEnv();
    first["INJECTED"] = "1";

    expect(claudeCodeEnv()).not.toHaveProperty("INJECTED");
  });
});
