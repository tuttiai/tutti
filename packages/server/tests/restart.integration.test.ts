/**
 * The server image keeps pending approvals across a restart: a run pauses
 * on a gated tool, the process is killed with SIGKILL, a new one starts on
 * the same state, and resolving the approval finishes the run there.
 *
 * Runs the built `dist/start.js` against a fake model on loopback: no
 * network, no API key, no timers. Every wait is on a log line or a frame.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsManager } from "@tuttiai/core";

import { startImage, type ImageEnv, type ImageProcess } from "./restart/child.js";
import { DELETE_CALL, WRITE_CALL, startFakeOpenAI, type FakeOpenAI } from "./restart/fake-openai.js";
import { call, runUntilApproval, type Approval } from "./restart/http.js";

const PG_URL = SecretsManager.optional("TUTTI_PG_URL");
const TIMEOUT = 60_000;

let root: string;
let fake: FakeOpenAI;
const running: ImageProcess[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tutti-restart-"));
  fake = await startFakeOpenAI();
});

afterEach(async () => {
  await Promise.all(running.splice(0).map((image) => image.kill()));
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(env: ImageEnv): Promise<ImageProcess> {
  const image = await startImage(env);
  running.push(image);
  return image;
}

/** Pause a run on the gate, SIGKILL the image, and start a new one on the same configuration. */
async function pauseKillRestart(env: ImageEnv): Promise<{ after: ImageProcess; approval: Approval; requestsBefore: number }> {
  const before = await start(env);
  const approval = await runUntilApproval(before);
  await before.kill();
  const after = await start(env);
  return { after, approval, requestsBefore: fake.requests.length };
}

function fileEnv(): ImageEnv {
  return { workspace: root, openaiUrl: fake.url, stateDir: join(root, "state") };
}

async function approveAndFinish(after: ImageProcess, approval: Approval, requestsBefore: number): Promise<void> {
  const pending = await call(after, "GET", "/interrupts/pending");
  expect(pending.json["interrupts"]).toEqual([
    expect.objectContaining({ ...approval, tool_name: "delete_file", tool_args: expect.objectContaining({ path: "marker.txt" }) }),
  ]);
  expect(existsSync(join(root, "marker.txt"))).toBe(true);

  expect((await call(after, "POST", `/interrupts/${approval.interrupt_id}/approve`)).status).toBe(200);
  await after.logLine("Agent finished");

  // The gated call ran once, and the write that finished before the kill did not run again.
  expect(existsSync(join(root, "marker.txt"))).toBe(false);
  expect(fake.requests.slice(requestsBefore)).toEqual([[WRITE_CALL, DELETE_CALL]]);
  const session = await call(after, "GET", `/sessions/${approval.session_id}`);
  expect(JSON.stringify(session.json["turns"])).toContain("done");

  const again = await call(after, "POST", `/interrupts/${approval.interrupt_id}/approve`);
  expect(again.status).toBe(409);
  expect(again.json).toMatchObject({ error: "already_resolved" });
  expect(fake.requests).toHaveLength(requestsBefore + 1);
}

describe("server image restart with TUTTI_STATE_DIR", () => {
  it("lists the approval again and finishes the run once it is approved", async () => {
    const { after, approval, requestsBefore } = await pauseKillRestart(fileEnv());
    expect((await after.logLine("Tutti server started"))["durability"]).toBe("file");
    await approveAndFinish(after, approval, requestsBefore);
  }, TIMEOUT);

  it("ends the run on a denial without running the gated call", async () => {
    const { after, approval, requestsBefore } = await pauseKillRestart(fileEnv());

    const denied = await call(after, "POST", `/interrupts/${approval.interrupt_id}/deny`, { reason: "Keep the marker" });
    expect(denied.status).toBe(200);
    expect(denied.json).toMatchObject({ status: "denied", denial_reason: "Keep the marker" });
    await after.logLine("Resumed run ended by the recorded denial");

    expect(existsSync(join(root, "marker.txt"))).toBe(true);
    expect(fake.requests).toHaveLength(requestsBefore);
  }, TIMEOUT);

  it("answers 500 for a corrupt record and keeps serving the others", async () => {
    const { after, approval } = await pauseKillRestart(fileEnv());
    const corrupt = "44444444-4444-4444-8444-444444444444";
    writeFileSync(join(root, "state", "interrupts", `${corrupt}.json`), "{broken");

    const res = await call(after, "POST", `/interrupts/${corrupt}/approve`);
    expect(res).toEqual({ status: 500, json: { error: "interrupt_record_corrupt", message: `interrupt ${corrupt} record is unreadable` } });
    const pending = await call(after, "GET", "/interrupts/pending");
    expect(pending.json["interrupts"]).toEqual([expect.objectContaining({ interrupt_id: approval.interrupt_id })]);
  }, TIMEOUT);
});

describe.skipIf(PG_URL === undefined)("server image restart with TUTTI_PG_URL", () => {
  it("finishes the run after a restart with sessions in memory", async () => {
    const env: ImageEnv = { workspace: root, openaiUrl: fake.url, ...(PG_URL !== undefined ? { pgUrl: PG_URL } : {}) };
    const { after, approval, requestsBefore } = await pauseKillRestart(env);
    expect((await after.logLine("Tutti server started"))["durability"]).toBe("postgres");
    await approveAndFinish(after, approval, requestsBefore);
  }, TIMEOUT);
});
