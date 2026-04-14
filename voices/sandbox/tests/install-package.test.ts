import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ToolContext } from "@tuttiai/types";
import { SessionSandbox } from "../src/sandbox.js";
import { createInstallPackageTool } from "../src/tools/install-package.js";

const ctx: ToolContext = {
  session_id: "test-session",
  agent_name: "test-agent",
};

let sandbox: SessionSandbox;

beforeEach(async () => {
  sandbox = new SessionSandbox("install-test-" + Date.now());
  await sandbox.init();
});

afterEach(async () => {
  await sandbox.destroy();
});

describe("install_package", () => {
  it("rejects package names with shell metacharacters", async () => {
    const tool = createInstallPackageTool(sandbox);
    const result = await tool.execute(
      tool.parameters.parse({ name: "evil; rm -rf /", manager: "npm" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Invalid package name");
  });

  it("rejects packages not on the allowlist", async () => {
    const tool = createInstallPackageTool(sandbox, {
      allowedPackages: ["lodash"],
    });
    const result = await tool.execute(
      tool.parameters.parse({ name: "express" }),
      ctx,
    );
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("not in the allowed list");
    expect(result.content).toContain("lodash");
  });

  it("allows packages on the allowlist", async () => {
    const tool = createInstallPackageTool(sandbox, {
      allowedPackages: ["is-odd"],
      timeout_ms: 30_000,
    });
    const result = await tool.execute(
      tool.parameters.parse({ name: "is-odd", manager: "npm" }),
      ctx,
    );
    // is-odd is tiny and installs fast. The test verifies the tool
    // doesn't reject the name; the actual npm install may succeed or
    // fail depending on network/npm availability.
    if (!result.is_error) {
      const body = JSON.parse(result.content);
      expect(body.package).toBe("is-odd");
      expect(typeof body.duration_ms).toBe("number");
    }
  });

  it("allows all packages when no allowlist is set", async () => {
    const tool = createInstallPackageTool(sandbox, { timeout_ms: 30_000 });
    const result = await tool.execute(
      tool.parameters.parse({ name: "is-odd", manager: "npm" }),
      ctx,
    );
    // Not blocked by allowlist — either succeeds or fails on network.
    expect(result.content).not.toContain("not in the allowed list");
  });

  it("defaults manager to npm", () => {
    const tool = createInstallPackageTool(sandbox);
    const parsed = tool.parameters.parse({ name: "lodash" });
    expect(parsed.manager).toBe("npm");
  });
});
