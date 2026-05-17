import { describe, it, expect, afterAll } from "vitest";
import { resolve } from "node:path";
import {
  existsSync,
  readFileSync,
  statSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

import {
  buildModalApp,
  buildModalEnvExample,
  buildModalDeployScript,
  generateModalBundle,
} from "../src/targets/modal.js";
import type { DeployManifest } from "../src/types.js";

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "tutti-deploy-modal-"));
  created.push(dir);
  return dir;
}

function baseManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    agent_name: "api",
    target: "modal",
    name: "my-agent",
    region: "auto",
    env: {},
    secrets: [],
    scale: { minInstances: 0, maxInstances: 3 },
    healthCheck: { path: "/health", intervalSeconds: 30 },
    services: { postgres: false, redis: false },
    ...overrides,
  };
}

describe("buildModalApp", () => {
  it("emits the standard image, app, function, and web_server blocks", () => {
    const py = buildModalApp(baseManifest());

    expect(py).toContain("import modal");
    expect(py).toContain("import subprocess");
    expect(py).toContain('APP_NAME = \'my-agent\'');
    expect(py).toContain(
      'modal.Image.from_registry("node:20-bookworm-slim", add_python="3.11")',
    );
    expect(py).toContain("npm install -g tutti-ai@{CLI_VERSION}");
    expect(py).toContain("npm install -g @tuttiai/cli@{CLI_VERSION}");
    expect(py).toContain('.add_local_file("tutti.score.ts", "/app/tutti.score.ts")');
    expect(py).toContain("app = modal.App(APP_NAME)");
    expect(py).toContain("@app.function(");
    expect(py).toContain("@modal.web_server(port=3000, startup_timeout=120)");
    expect(py).toContain(
      'subprocess.Popen(["tutti-ai", "serve", "--score", "/app/tutti.score.ts"])',
    );
  });

  it("uses 2gb memory string as memory=2048 on the Modal function", () => {
    const py = buildModalApp(
      baseManifest({
        scale: { minInstances: 0, maxInstances: 3, memory: "2gb" },
      }),
    );
    expect(py).toContain("memory=2048,");
  });

  it("uses 512mb memory string as memory=512", () => {
    const py = buildModalApp(
      baseManifest({
        scale: { minInstances: 0, maxInstances: 3, memory: "512mb" },
      }),
    );
    expect(py).toContain("memory=512,");
  });

  it("defaults memory to 2048 when scale.memory is unset (Modal requires an integer)", () => {
    const py = buildModalApp(baseManifest());
    expect(py).toContain("memory=2048,");
  });

  it("declares one modal.Secret.from_name line per declared secret", () => {
    const py = buildModalApp(
      baseManifest({
        secrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY"],
      }),
    );

    const matches = py.match(/= modal\.Secret\.from_name\(/g) ?? [];
    expect(matches.length).toBe(3);
    expect(py).toContain(
      "ANTHROPIC_API_KEY = modal.Secret.from_name('tutti-anthropic-api-key')",
    );
    expect(py).toContain(
      "GITHUB_TOKEN = modal.Secret.from_name('tutti-github-token')",
    );
    expect(py).toContain(
      "STRIPE_SECRET_KEY = modal.Secret.from_name('tutti-stripe-secret-key')",
    );
    expect(py).toContain(
      "secrets=[ANTHROPIC_API_KEY, GITHUB_TOKEN, STRIPE_SECRET_KEY],",
    );
  });

  it("emits secrets=[] and no Secret.from_name when no secrets are declared", () => {
    const py = buildModalApp(baseManifest());
    expect(py).toContain("secrets=[],");
    expect(py).not.toContain("modal.Secret.from_name");
  });

  it("emits plaintext env vars as the function's env= dict", () => {
    const py = buildModalApp(
      baseManifest({ env: { LOG_LEVEL: "debug", FEATURE_X: "on" } }),
    );
    expect(py).toContain("env={'LOG_LEVEL': 'debug', 'FEATURE_X': 'on'},");
  });

  it("emits env={} when no env vars are declared", () => {
    const py = buildModalApp(baseManifest());
    expect(py).toContain("env={},");
  });

  it("matches the snapshot for a representative manifest", () => {
    const py = buildModalApp(
      baseManifest({
        name: "marketing-agent",
        env: { LOG_LEVEL: "info" },
        secrets: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
        scale: { minInstances: 0, maxInstances: 3, memory: "2gb" },
      }),
    );
    expect(py).toMatchSnapshot();
  });
});

describe("buildModalEnvExample", () => {
  it("lists one line per declared secret", () => {
    const txt = buildModalEnvExample(
      baseManifest({
        secrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "STRIPE_SECRET_KEY"],
      }),
    );
    const lines = txt.split("\n").filter((l) => l.endsWith("="));
    expect(lines).toEqual([
      "ANTHROPIC_API_KEY=",
      "GITHUB_TOKEN=",
      "STRIPE_SECRET_KEY=",
    ]);
  });

  it("emits only the header comment when no secrets are declared", () => {
    const txt = buildModalEnvExample(baseManifest());
    expect(txt).toContain("# Secrets required by this Modal deployment.");
    expect(txt.split("\n").filter((l) => l.includes("="))).toEqual([]);
  });
});

describe("buildModalDeployScript", () => {
  it("documents `modal secret create` for each declared secret", () => {
    const sh = buildModalDeployScript(
      baseManifest({ secrets: ["ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY"] }),
    );
    expect(sh).toContain(
      "modal secret create tutti-anthropic-api-key --env ANTHROPIC_API_KEY=...",
    );
    expect(sh).toContain(
      "modal secret create tutti-stripe-secret-key --env STRIPE_SECRET_KEY=...",
    );
    expect(sh).toContain("modal deploy modal_app.py");
    expect(sh.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("notes 'no secrets declared' when manifest.secrets is empty", () => {
    const sh = buildModalDeployScript(baseManifest());
    expect(sh).toContain("(no secrets declared for this deployment)");
    expect(sh).toContain("modal deploy modal_app.py");
  });
});

describe("generateModalBundle", () => {
  afterAll(() => {
    for (const dir of created) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  it("writes modal_app.py, tutti.score.ts, .env.modal.example, deploy.sh", async () => {
    const dir = tempDir();
    const scorePath = resolve(dir, "source.score.ts");
    writeFileSync(scorePath, "// example score\n");

    await generateModalBundle(baseManifest(), scorePath, dir);

    expect(existsSync(resolve(dir, "modal_app.py"))).toBe(true);
    expect(existsSync(resolve(dir, "tutti.score.ts"))).toBe(true);
    expect(existsSync(resolve(dir, ".env.modal.example"))).toBe(true);
    expect(existsSync(resolve(dir, "deploy.sh"))).toBe(true);
  });

  it("creates outDir when it does not yet exist", async () => {
    const parent = tempDir();
    const nested = resolve(parent, "nested", "build");
    const scorePath = resolve(parent, "source.score.ts");
    writeFileSync(scorePath, "// example score\n");
    expect(existsSync(nested)).toBe(false);

    await generateModalBundle(baseManifest(), scorePath, nested);

    expect(existsSync(resolve(nested, "modal_app.py"))).toBe(true);
  });

  it("copies the score file contents verbatim", async () => {
    const dir = tempDir();
    const scorePath = resolve(dir, "source.score.ts");
    const expected = "export const score = { agents: {} };\n";
    writeFileSync(scorePath, expected);

    await generateModalBundle(baseManifest(), scorePath, dir);

    const copied = readFileSync(resolve(dir, "tutti.score.ts"), "utf-8");
    expect(copied).toBe(expected);
  });

  it("writes deploy.sh with execute permission", async () => {
    const dir = tempDir();
    const scorePath = resolve(dir, "source.score.ts");
    writeFileSync(scorePath, "// example score\n");

    await generateModalBundle(baseManifest(), scorePath, dir);

    const stat = statSync(resolve(dir, "deploy.sh"));
    if (process.platform !== "win32") {
      expect(stat.mode & 0o100).toBe(0o100);
    }
  });
});
