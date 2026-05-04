import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

import {
  CLI_DEPLOY_TARGETS,
  parseTargetFlag,
  resolveDeployTarget,
  buildDeployPlan,
  formatDryRunPlan,
  deployCommand,
  printSecretsValidation,
  type DeployRunner,
} from "../../src/commands/deploy.js";
import type { DeployManifest, SecretsValidationResult } from "@tuttiai/deploy";

function baseManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    agent_name: "api",
    target: "docker",
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

describe("parseTargetFlag", () => {
  it("returns null when the flag is unset", () => {
    expect(parseTargetFlag(undefined)).toBeNull();
  });

  it.each(CLI_DEPLOY_TARGETS)("accepts %s as a valid target", (target) => {
    expect(parseTargetFlag(target)).toBe(target);
  });

  it("throws on an unknown target with the supported list in the message", () => {
    expect(() => parseTargetFlag("kubernetes")).toThrow(/Supported: docker, railway, fly/);
  });

  it("rejects cloudflare even though @tuttiai/deploy supports it as a manifest target", () => {
    // The CLI deliberately ships only docker / railway / fly today; cloudflare
    // would silently produce no Worker bundle.
    expect(() => parseTargetFlag("cloudflare")).toThrow();
  });
});

describe("resolveDeployTarget", () => {
  it("uses the manifest target when no flag is set", () => {
    expect(resolveDeployTarget(baseManifest({ target: "fly" }), null)).toBe("fly");
  });

  it("lets the --target flag override the manifest", () => {
    expect(resolveDeployTarget(baseManifest({ target: "fly" }), "docker")).toBe(
      "docker",
    );
  });

  it("throws when the manifest is cloudflare and no override is supplied", () => {
    expect(() =>
      resolveDeployTarget(baseManifest({ target: "cloudflare" }), null),
    ).toThrow(/Cloudflare/);
  });

  it("allows --target to rescue a cloudflare manifest", () => {
    expect(
      resolveDeployTarget(baseManifest({ target: "cloudflare" }), "fly"),
    ).toBe("fly");
  });
});

describe("buildDeployPlan", () => {
  describe("docker", () => {
    it("emits Dockerfile, .dockerignore, docker-compose.yml, and deploy.sh and zero commands", () => {
      const plan = buildDeployPlan(baseManifest(), "docker", "/tmp/out");

      const fileNames = plan.files.map((f) => f.path);
      expect(fileNames).toEqual([
        "/tmp/out/Dockerfile",
        "/tmp/out/.dockerignore",
        "/tmp/out/docker-compose.yml",
        "/tmp/out/deploy.sh",
      ]);
      expect(plan.commands).toEqual([]);
      expect(plan.requiredBinaries).toEqual([]);
    });

    it("marks deploy.sh as executable", () => {
      const plan = buildDeployPlan(baseManifest(), "docker", "/tmp/out");
      const script = plan.files.find((f) => f.path.endsWith("deploy.sh"));
      expect(script?.executable).toBe(true);
    });

    it("includes the docker run next-step with the deployment name", () => {
      const plan = buildDeployPlan(
        baseManifest({ name: "ship-it" }),
        "docker",
        "/tmp/out",
      );
      expect(plan.nextSteps.some((s) => s.includes("ship-it"))).toBe(true);
    });
  });

  describe("railway", () => {
    it("emits no files and a single railway up command", () => {
      const plan = buildDeployPlan(
        baseManifest({ name: "shipping-svc" }),
        "railway",
        "/tmp/out",
      );

      expect(plan.files).toEqual([]);
      expect(plan.commands).toHaveLength(1);
      expect(plan.commands[0]?.argv).toEqual([
        "railway",
        "up",
        "--detach",
        "--service",
        "shipping-svc",
      ]);
    });

    it("declares the railway CLI requirement with an install hint", () => {
      const plan = buildDeployPlan(baseManifest(), "railway", "/tmp/out");
      expect(plan.requiredBinaries).toEqual([
        {
          name: "railway",
          installHint: "Install Railway CLI: npm i -g @railway/cli",
        },
      ]);
    });
  });

  describe("fly", () => {
    it("emits fly.toml, Dockerfile, .dockerignore, and a fly deploy command", () => {
      const plan = buildDeployPlan(baseManifest(), "fly", "/tmp/out");

      const names = plan.files.map((f) => f.path.split("/").pop());
      expect(names).toEqual(["fly.toml", "Dockerfile", ".dockerignore"]);
      expect(plan.commands).toHaveLength(1);
      expect(plan.commands[0]?.argv).toEqual([
        "fly",
        "deploy",
        "--config",
        "fly.toml",
      ]);
    });

    it("renders the manifest's region into fly.toml", () => {
      const plan = buildDeployPlan(
        baseManifest({ region: "ams" }),
        "fly",
        "/tmp/out",
      );
      const flyToml = plan.files.find((f) => f.path.endsWith("fly.toml"));
      expect(flyToml?.contents).toContain('primary_region = "ams"');
    });

    it("declares the fly CLI requirement with an install hint", () => {
      const plan = buildDeployPlan(baseManifest(), "fly", "/tmp/out");
      expect(plan.requiredBinaries[0]?.name).toBe("fly");
    });
  });
});

describe("formatDryRunPlan", () => {
  it("lists every file and command that would be touched", () => {
    const plan = buildDeployPlan(baseManifest(), "fly", "/tmp/out");
    const out = formatDryRunPlan(plan);

    expect(out).toContain("Target: fly");
    expect(out).toContain("Files that would be written:");
    expect(out).toContain("/tmp/out/fly.toml");
    expect(out).toContain("Commands that would run:");
    expect(out).toContain("fly deploy --config fly.toml");
    expect(out).toContain("Required CLIs:");
  });

  it("omits the files / commands sections when they are empty", () => {
    const docker = formatDryRunPlan(
      buildDeployPlan(baseManifest(), "docker", "/tmp/out"),
    );
    expect(docker).not.toContain("Commands that would run:");
    expect(docker).toContain("Files that would be written:");

    const railway = formatDryRunPlan(
      buildDeployPlan(baseManifest(), "railway", "/tmp/out"),
    );
    expect(railway).not.toContain("Files that would be written:");
    expect(railway).toContain("Commands that would run:");
  });
});

describe("deployCommand — manifest validation", () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-deploy-cli-"));
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        // Throw to short-circuit the calling function under test the same
        // way real `process.exit` halts execution.
        throw new Error(`__exit__:${String(code ?? 0)}`);
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeScore(content: string): string {
    const path = resolve(dir, "tutti.score.mjs");
    writeFileSync(path, content, "utf-8");
    return path;
  }

  it("exits with a clear error when the score file is missing", async () => {
    await expect(
      deployCommand({ score: resolve(dir, "does-not-exist.mjs") }),
    ).rejects.toThrow("__exit__:1");

    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("Score file not found");
  });

  it("exits with a clear error when the score has no deployable agent", async () => {
    const score = writeScore(`export default {
      provider: { chat: async () => ({}) },
      agents: {
        bot: { name: "bot", system_prompt: "h", voices: [] },
      },
    };`);

    await expect(deployCommand({ score })).rejects.toThrow("__exit__:1");
    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("no deployable agents");
  });

  it("exits with a clear error when the deploy block has an invalid target", async () => {
    const score = writeScore(`export default {
      provider: { chat: async () => ({}) },
      agents: {
        api: {
          name: "api",
          system_prompt: "h",
          voices: [],
          deploy: { target: "kubernetes" },
        },
      },
    };`);

    await expect(deployCommand({ score })).rejects.toThrow("__exit__:1");
    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("Deploy validation failed");
  });

  it("exits with a clear error when --target is unknown", async () => {
    const score = writeScore(`export default {
      provider: { chat: async () => ({}) },
      agents: {
        api: {
          name: "api",
          system_prompt: "h",
          voices: [],
          deploy: { target: "docker" },
        },
      },
    };`);

    await expect(
      deployCommand({ score, target: "kubernetes" }),
    ).rejects.toThrow("__exit__:1");
    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("Unknown --target");
  });
});

describe("deployCommand — dry-run mode", () => {
  let dir: string;
  let outDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let runner: DeployRunner;
  let whichCalls: string[];
  let spawnCalls: string[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-deploy-dryrun-"));
    outDir = join(dir, "out");
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit__:${String(code ?? 0)}`);
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    whichCalls = [];
    spawnCalls = [];
    runner = {
      which: (name) => {
        whichCalls.push(name);
        return true;
      },
      spawn: (argv) => {
        spawnCalls.push(argv);
        return { status: 0 };
      },
    };
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDeployableScore(target: "docker" | "railway" | "fly"): string {
    const path = resolve(dir, "tutti.score.mjs");
    writeFileSync(
      path,
      `export default {
        provider: { chat: async () => ({}) },
        agents: {
          api: {
            name: "api",
            system_prompt: "h",
            voices: [],
            deploy: { target: "${target}", name: "shipping-svc" },
          },
        },
      };`,
      "utf-8",
    );
    return path;
  }

  it("does NOT invoke the platform CLI under --dry-run for railway", async () => {
    const score = writeDeployableScore("railway");

    await deployCommand(
      { score, dryRun: true, outDir },
      runner,
    );

    expect(spawnCalls).toEqual([]);
    expect(whichCalls).toEqual([]);
  });

  it("does NOT invoke the platform CLI under --dry-run for fly", async () => {
    const score = writeDeployableScore("fly");

    await deployCommand({ score, dryRun: true, outDir }, runner);

    expect(spawnCalls).toEqual([]);
    expect(whichCalls).toEqual([]);
  });

  it("does NOT write any files under --dry-run", async () => {
    const score = writeDeployableScore("docker");
    mkdirSync(outDir, { recursive: true });

    await deployCommand({ score, dryRun: true, outDir }, runner);

    expect(existsSync(join(outDir, "Dockerfile"))).toBe(false);
    expect(existsSync(join(outDir, "deploy.sh"))).toBe(false);
  });

  it("prints the dry-run plan including target, files, and commands", async () => {
    const score = writeDeployableScore("fly");

    await deployCommand({ score, dryRun: true, outDir }, runner);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Target: fly");
    expect(out).toContain("Files that would be written:");
    expect(out).toContain("fly.toml");
    expect(out).toContain("Commands that would run:");
    expect(out).toContain("fly deploy --config fly.toml");
    expect(out).toContain("Dry run");
  });

  it("honours --target override under --dry-run", async () => {
    const score = writeDeployableScore("docker");

    await deployCommand(
      { score, target: "railway", dryRun: true, outDir },
      runner,
    );

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Target: railway");
    expect(out).toContain("railway up --detach --service shipping-svc");
  });

  it("DOES invoke the platform CLI in real-run mode (sanity check)", async () => {
    const score = writeDeployableScore("railway");

    await deployCommand({ score, outDir }, runner);

    expect(whichCalls).toEqual(["railway"]);
    expect(spawnCalls).toEqual([
      ["railway", "up", "--detach", "--service", "shipping-svc"],
    ]);
  });

  it("exits with a clear error when a required CLI is missing in real-run mode", async () => {
    const score = writeDeployableScore("railway");
    runner.which = (name) => {
      whichCalls.push(name);
      return false;
    };

    await expect(
      deployCommand({ score, outDir }, runner),
    ).rejects.toThrow("__exit__:1");

    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("railway CLI not found");
    expect(errors).toContain("Install Railway CLI: npm i -g @railway/cli");
    expect(spawnCalls).toEqual([]); // never tried to run anything
  });

  it("writes the docker bundle in real-run mode for the docker target", async () => {
    const score = writeDeployableScore("docker");

    await deployCommand({ score, outDir }, runner);

    expect(existsSync(join(outDir, "Dockerfile"))).toBe(true);
    expect(existsSync(join(outDir, "deploy.sh"))).toBe(true);
    expect(readFileSync(join(outDir, "Dockerfile"), "utf-8")).toContain(
      "FROM node:20-alpine",
    );
    expect(spawnCalls).toEqual([]); // docker target runs no platform CLI itself
  });
});

describe("printSecretsValidation", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  function result(over: Partial<SecretsValidationResult> = {}): SecretsValidationResult {
    return {
      errors: [],
      warnings: [],
      declared: [],
      required: [],
      passed: true,
      ...over,
    };
  }

  it("prints errors via console.error in red prefixed with ✘", () => {
    printSecretsValidation(
      result({
        passed: false,
        errors: [
          "Missing required env var: OPENAI_API_KEY — add it to deploy.secrets in your score file",
        ],
      }),
    );

    const out = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("✘");
    expect(out).toContain("OPENAI_API_KEY");
  });

  it("prints warnings via console.log in yellow prefixed with ⚠", () => {
    printSecretsValidation(
      result({
        warnings: [
          "STRIPE_SECRET_KEY is in deploy.env — move it to deploy.secrets to avoid exposing it",
        ],
      }),
    );

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("⚠");
    expect(out).toContain("STRIPE_SECRET_KEY");
  });

  it("prints the green confirmation with a count when passed and no warnings", () => {
    printSecretsValidation(
      result({
        required: ["OPENAI_API_KEY", "DATABASE_URL", "GITHUB_TOKEN"],
        declared: ["DATABASE_URL", "GITHUB_TOKEN", "OPENAI_API_KEY"],
      }),
    );

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Secrets validation passed");
    expect(out).toContain("3 secrets will be injected by the platform");
  });

  it("singularises 'secret' when only one is required", () => {
    printSecretsValidation(
      result({
        required: ["OPENAI_API_KEY"],
        declared: ["OPENAI_API_KEY"],
      }),
    );

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("1 secret will be injected by the platform");
  });

  it("uses the no-required-vars phrasing when nothing was detected", () => {
    printSecretsValidation(result());

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("no required env vars detected");
  });
});

describe("deployCommand — secrets validation flow", () => {
  let dir: string;
  let outDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let runner: DeployRunner;
  let spawnCalls: string[][];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tutti-deploy-secrets-"));
    outDir = join(dir, "out");
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`__exit__:${String(code ?? 0)}`);
      }) as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    spawnCalls = [];
    runner = {
      which: () => true,
      spawn: (argv) => {
        spawnCalls.push(argv);
        return { status: 0 };
      },
    };
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeScore(body: string): string {
    const path = resolve(dir, "tutti.score.mjs");
    writeFileSync(path, body, "utf-8");
    return path;
  }

  it("blocks the deploy and exits with a clear error when a required var is missing", async () => {
    const score = writeScore(
      `// score uses OPENAI_API_KEY but never declares it
       const k = process.env.OPENAI_API_KEY;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: { target: "railway" },
           },
         },
       };`,
    );

    await expect(
      deployCommand({ score, outDir }, runner),
    ).rejects.toThrow("__exit__:1");

    const errors = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).toContain("Missing required env var: OPENAI_API_KEY");
    expect(errors).toContain("Fix the missing env var declarations");
    expect(spawnCalls).toEqual([]); // never reached the platform CLI
  });

  it("warns but continues when a secret-shaped name is in deploy.env", async () => {
    const score = writeScore(
      `const k = process.env.STRIPE_SECRET_KEY;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: {
               target: "railway",
               env: { STRIPE_SECRET_KEY: "x" },
             },
           },
         },
       };`,
    );

    await deployCommand({ score, outDir }, runner);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("STRIPE_SECRET_KEY is in deploy.env");
    expect(spawnCalls).toEqual([
      ["railway", "up", "--detach", "--service", "api"],
    ]);
  });

  it("prints the green confirmation when validation passes cleanly", async () => {
    const score = writeScore(
      `const k = process.env.ANTHROPIC_API_KEY;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: {
               target: "railway",
               secrets: ["ANTHROPIC_API_KEY"],
             },
           },
         },
       };`,
    );

    await deployCommand({ score, outDir }, runner);

    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Secrets validation passed");
    expect(out).toContain("1 secret will be injected by the platform");
  });

  it("writes .env.deploy.example next to the score in real-run mode", async () => {
    const score = writeScore(
      `const k = process.env.ANTHROPIC_API_KEY;
       const d = process.env.DATABASE_URL;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: {
               target: "railway",
               secrets: ["ANTHROPIC_API_KEY", "DATABASE_URL"],
             },
           },
         },
       };`,
    );

    await deployCommand({ score, outDir }, runner);

    const examplePath = resolve(dir, ".env.deploy.example");
    expect(existsSync(examplePath)).toBe(true);
    const text = readFileSync(examplePath, "utf-8");
    expect(text).toContain("ANTHROPIC_API_KEY=<your-anthropic-api-key>");
    expect(text).toContain("DATABASE_URL=<your-database-url>");
  });

  it("does NOT write .env.deploy.example under --dry-run, but lists it in the plan", async () => {
    const score = writeScore(
      `const k = process.env.ANTHROPIC_API_KEY;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: {
               target: "railway",
               secrets: ["ANTHROPIC_API_KEY"],
             },
           },
         },
       };`,
    );

    await deployCommand({ score, outDir, dryRun: true }, runner);

    const examplePath = resolve(dir, ".env.deploy.example");
    expect(existsSync(examplePath)).toBe(false);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(out).toContain("Would also write:");
    expect(out).toContain(".env.deploy.example");
    expect(spawnCalls).toEqual([]);
  });

  it("validation runs BEFORE plan execution — a missing var blocks file writes too", async () => {
    const score = writeScore(
      `const k = process.env.MISSING_KEY;
       export default {
         provider: { chat: async () => ({}) },
         agents: {
           api: {
             name: "api",
             system_prompt: "h",
             voices: [],
             deploy: { target: "docker" },
           },
         },
       };`,
    );

    await expect(
      deployCommand({ score, outDir }, runner),
    ).rejects.toThrow("__exit__:1");

    expect(existsSync(join(outDir, "Dockerfile"))).toBe(false);
  });
});
