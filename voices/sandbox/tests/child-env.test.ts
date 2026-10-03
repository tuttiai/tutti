import { afterEach, describe, expect, it, vi } from "vitest";

import { childEnv } from "../src/utils/child-env.js";
import { execute } from "../src/executor.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("childEnv", () => {
  it("keeps allowlisted variables", () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/home/tutti");

    const env = childEnv();

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/tutti");
  });

  it("drops credentials and anything not allowlisted", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-secret");
    vi.stubEnv("TUTTI_VOICES", '[{"voice":"github","options":{"token":"ghp_secret"}}]');
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-secret");

    const env = childEnv();

    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.TUTTI_VOICES).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("drops NODE_ENV so npm ci installs devDependencies", () => {
    vi.stubEnv("NODE_ENV", "production");

    expect(childEnv().NODE_ENV).toBeUndefined();
  });

  it("lets configured variables win over inherited ones", () => {
    vi.stubEnv("HOME", "/home/tutti");

    const env = childEnv({ HOME: "/work/home", CI: "1" });

    expect(env.HOME).toBe("/work/home");
    expect(env.CI).toBe("1");
  });

  it("omits an allowlisted variable that is unset", () => {
    vi.stubEnv("HTTPS_PROXY", undefined);

    expect("HTTPS_PROXY" in childEnv()).toBe(false);
  });
});

describe("execute — environment", () => {
  it("does not expose the agent's credentials to a snippet", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-secret");

    const r = await execute('echo "[${CLAUDE_CODE_OAUTH_TOKEN:-unset}]"', "bash");

    expect(r.stdout.trim()).toBe("[unset]");
  });
});
