import { cp, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolContext, VoiceContext } from "@tuttiai/types";

import { SandboxVoice } from "../src/index.js";
import { createReadFileTool, sliceLines } from "../src/tools/read-file.js";
import { createRepoMapTool, REPO_MAP_CACHE_DIR } from "../src/tools/repo-map.js";
import { SessionSandbox } from "../src/sandbox.js";
import { copyFixture } from "./fixtures/repo-map/index.js";
import type { FixtureCopy } from "./fixtures/repo-map/index.js";

const ctx: ToolContext = { session_id: "t", agent_name: "t" };

let sandbox: SessionSandbox;
let fixture: FixtureCopy;

beforeEach(async () => {
  sandbox = new SessionSandbox(`repo-map-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await sandbox.init();
  fixture = await copyFixture("ranking");
});

afterEach(async () => {
  await sandbox.destroy();
  await fixture.cleanup();
});

async function cloneIntoSandbox(): Promise<void> {
  await cp(fixture.repo, join(sandbox.root, "repo"), { recursive: true });
}

describe("repo_map tool", () => {
  it("maps a directory in the sandbox and caches its tags there", async () => {
    await cloneIntoSandbox();
    const tool = createRepoMapTool(sandbox);
    const result = await tool.execute(tool.parameters.parse({ path: "repo" }), ctx);
    expect(result.is_error).toBeUndefined();
    expect(result.content.split("\n")[0]).toBe("src/core/widget-registry.ts");
    expect((await readdir(sandbox.resolve(REPO_MAP_CACHE_DIR))).some((f) => f.endsWith(".json"))).toBe(true);
  });

  it("validates its input", () => {
    const tool = createRepoMapTool(sandbox);
    expect(() => tool.parameters.parse({ max_tokens: 7000 })).toThrow();
    expect(() => tool.parameters.parse({ focus: [""] })).toThrow();
    expect(tool.parameters.parse({ focus: ["src/a.ts", "registerWidget"] })).toBeTruthy();
  });

  it("refuses a path that is not a directory", async () => {
    const tool = createRepoMapTool(sandbox);
    const result = await tool.execute(tool.parameters.parse({ path: "missing" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).toContain("Not a directory");
  });

  it("refuses a path outside the sandbox", async () => {
    const tool = createRepoMapTool(sandbox);
    const result = await tool.execute(tool.parameters.parse({ path: "../../etc" }), ctx);
    expect(result.is_error).toBe(true);
    expect(result.content).not.toContain(sandbox.root);
  });

  it("refuses a symbolic link that leads out of the sandbox", async () => {
    await symlink(fixture.repo, join(sandbox.root, "escape"));
    const tool = createRepoMapTool(sandbox);
    const result = await tool.execute(tool.parameters.parse({ path: "escape" }), ctx);
    expect(result.is_error).toBe(true);
  });

  it("tells the agent to call it first and then read line ranges", () => {
    const tool = createRepoMapTool(sandbox);
    expect(tool.description).toContain("Call this first");
    expect(tool.description).toContain("start_line");
  });

  it("is the first tool of the sandbox voice", async () => {
    const voice = new SandboxVoice();
    const voiceCtx: VoiceContext = { session_id: `voice-${Date.now()}`, agent_name: "t" };
    await voice.setup(voiceCtx);
    try {
      expect(voice.tools[0]?.name).toBe("repo_map");
    } finally {
      await voice.teardown();
    }
  });
});

describe("read_file line ranges", () => {
  beforeEach(async () => {
    await mkdir(sandbox.root, { recursive: true });
    await writeFile(join(sandbox.root, "lines.txt"), "one\ntwo\nthree\nfour\nfive");
  });

  it("returns only the lines asked for, with a header", async () => {
    const tool = createReadFileTool(sandbox);
    const result = await tool.execute(tool.parameters.parse({ path: "lines.txt", start_line: 2, end_line: 3 }), ctx);
    expect(result.content).toBe("[lines 2-3 of 5]\ntwo\nthree");
  });

  it("reads to the end when end_line is absent and leaves whole reads unchanged", async () => {
    const tool = createReadFileTool(sandbox);
    const tail = await tool.execute(tool.parameters.parse({ path: "lines.txt", start_line: 4 }), ctx);
    expect(tail.content).toBe("[lines 4-5 of 5]\nfour\nfive");
    const whole = await tool.execute(tool.parameters.parse({ path: "lines.txt" }), ctx);
    expect(whole.content).toBe("one\ntwo\nthree\nfour\nfive");
  });

  it("refuses a reversed range and a range with base64", async () => {
    const tool = createReadFileTool(sandbox);
    const reversed = await tool.execute(tool.parameters.parse({ path: "lines.txt", start_line: 3, end_line: 2 }), ctx);
    expect(reversed.is_error).toBe(true);
    const b64 = await tool.execute(tool.parameters.parse({ path: "lines.txt", encoding: "base64", start_line: 1 }), ctx);
    expect(b64.is_error).toBe(true);
  });

  it("says when the start is past the end", () => {
    expect(sliceLines("a\nb", 9)).toBe("[line 9 is past the end: the file has 2 lines]");
  });
});
