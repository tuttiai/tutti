/**
 * Runs the built server image (`dist/start.js`) as a child process, the way
 * the container does, and waits on its log lines rather than on timers.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { SecretsManager } from "@tuttiai/core";

const START = fileURLToPath(new URL("../../dist/start.js", import.meta.url));

/** The API key the child's routes require. Not a provider key. */
export const CHILD_API_KEY = "restart-test-key";

/** One running server image. */
export interface ImageProcess {
  base: string;
  child: ChildProcess;
  /** Resolves with the first log line whose `msg` equals `msg`. */
  logLine: (msg: string) => Promise<Record<string, unknown>>;
  kill: () => Promise<void>;
}

/** The environment of the child, beyond `PATH`. */
export interface ImageEnv {
  workspace: string;
  openaiUrl: string;
  stateDir?: string;
  pgUrl?: string;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no TCP port");
  return address.port;
}

function environment(env: ImageEnv, port: number): Record<string, string> {
  return {
    PATH: SecretsManager.optional("PATH") ?? "",
    // JSON log lines, as in the container, so the test can wait on them.
    NODE_ENV: "production",
    TUTTI_PROVIDER: "openai",
    TUTTI_MODEL: "fake-model",
    OPENAI_API_KEY: "not-a-real-key",
    OPENAI_BASE_URL: env.openaiUrl,
    TUTTI_API_KEY: CHILD_API_KEY,
    TUTTI_VOICES: JSON.stringify([{ voice: "filesystem" }]),
    TUTTI_PERMISSIONS: "filesystem",
    TUTTI_REQUIRE_APPROVAL: "delete_file",
    TUTTI_PORT: String(port),
    TUTTI_HOST: "127.0.0.1",
    ...(env.stateDir !== undefined ? { TUTTI_STATE_DIR: env.stateDir } : {}),
    ...(env.pgUrl !== undefined ? { TUTTI_PG_URL: env.pgUrl } : {}),
  };
}

function lineWatcher(child: ChildProcess): (msg: string) => Promise<Record<string, unknown>> {
  const seen: Record<string, unknown>[] = [];
  const waiting: { msg: string; resolve: (line: Record<string, unknown>) => void }[] = [];
  let buffer = "";
  child.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const text of lines) {
      let line: Record<string, unknown>;
      try {
        line = z.record(z.unknown()).parse(JSON.parse(text));
      } catch {
        continue;
      }
      seen.push(line);
      for (const w of waiting.filter((x) => x.msg === line["msg"])) w.resolve(line);
    }
  });
  return (msg) => {
    const found = seen.find((line) => line["msg"] === msg);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => waiting.push({ msg, resolve }));
  };
}

/**
 * Start the image and wait for its "Tutti server started" line.
 *
 * @param env - Workspace (the child's cwd), fake model URL and stores.
 * @returns The running process.
 */
export async function startImage(env: ImageEnv): Promise<ImageProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, [START], { cwd: env.workspace, env: environment(env, port), stdio: ["ignore", "pipe", "pipe"] });
  const logLine = lineWatcher(child);
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await Promise.race([logLine("Tutti server started"), exited.then(() => { throw new Error("server image exited before it started"); })]);
  return {
    base: `http://127.0.0.1:${port}`,
    child,
    logLine,
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    },
  };
}
