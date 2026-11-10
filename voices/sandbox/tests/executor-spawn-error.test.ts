import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { execute } from "../src/executor.js";

// Mocked so a spawn failure can carry the working directory in its message,
// which a real ENOENT from Node does not. Kept in this file only: vi.mock
// applies to the whole file and would replace the real child process elsewhere.
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFileSync: vi.fn() }));

const DIR = "/home/alice/tutti-sandbox/session-1";

/** A child process that fails to start: it emits `error` and never `close`. */
function failingChild(message: string): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  queueMicrotask(() => child.emit("error", new Error(message)));
  // Safe: execute() only uses on(), stdout, stderr and kill(), which the fake has.
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

describe("execute spawn error redaction", () => {
  it("hides the working directory in the spawn error", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      failingChild(`spawn /bin/bash ENOENT, cwd '${DIR}'`),
    );
    const result = await execute("echo hi", "bash", { working_dir: DIR });
    expect(result.exit_code).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("spawn /bin/bash ENOENT, cwd '<workdir>'");
    expect(result.stderr).not.toContain(DIR);
  });

  it("redacts every occurrence of the working directory", async () => {
    vi.mocked(spawn).mockImplementation(() =>
      failingChild(`EACCES ${DIR}/a and ${DIR}/b`),
    );
    const result = await execute("echo hi", "bash", { working_dir: DIR });
    expect(result.stderr).toBe("EACCES <workdir>/a and <workdir>/b");
  });

  it("redacts the temp directory when no working_dir is given", async () => {
    const dir = tmpdir();
    vi.mocked(spawn).mockImplementation(() =>
      failingChild(`spawn /bin/bash ENOENT, cwd '${dir}'`),
    );
    const result = await execute("echo hi", "bash");
    expect(result.exit_code).toBe(127);
    expect(result.stderr).toBe("spawn /bin/bash ENOENT, cwd '<workdir>'");
  });

  it("leaves a message without the directory as it is", async () => {
    vi.mocked(spawn).mockImplementation(() => failingChild("spawn bash ENOENT"));
    const result = await execute("echo hi", "bash", { working_dir: DIR });
    expect(result.stderr).toBe("spawn bash ENOENT");
  });
});
