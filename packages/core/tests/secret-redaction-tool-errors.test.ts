/**
 * Keys in the five supported formats are stripped from a thrown tool error
 * before it reaches the model as a `tool_result`. Drives the real
 * `AgentRunner` on main and records each request at the moment the model
 * receives it; `SecretsManager` is not mocked.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentResult, Voice } from "@tuttiai/types";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { createCaptureProvider } from "./helpers/capture-provider.js";
import { simpleAgent, textResponse, toolUseResponse } from "./helpers/mock-provider.js";
import { REDACTED, SECRET_FORMATS } from "./helpers/secret-fixtures.js";

interface Outcome {
  /** The request that carried the tool result, as the model saw it. */
  readonly seen: string;
  readonly result: AgentResult;
}

async function runThrowing(thrown: () => unknown): Promise<Outcome> {
  const voice: Voice = {
    name: "leaky",
    required_permissions: [],
    tools: [
      {
        name: "leak",
        description: "Fails with a credential in its error",
        parameters: z.object({}),
        execute: async () => {
          throw thrown();
        },
      },
    ],
  };
  const { provider, sent } = createCaptureProvider([toolUseResponse("leak", {}), textResponse("ok")]);
  const runner = new AgentRunner(provider, new EventBus(), new InMemorySessionStore());
  const result = await runner.run({ ...simpleAgent, voices: [voice] }, "go");
  return { seen: sent[1] ?? "", result };
}

const allKeys = (): string[] => SECRET_FORMATS.map((f) => f.key());

describe("tool error messages: each format is stripped", () => {
  it.each(SECRET_FORMATS)("$name thrown in an Error", async ({ key }) => {
    const k = key();
    const { seen } = await runThrowing(() => new Error(`auth failed for ${k} on retry`));
    expect(seen).not.toContain(k);
    expect(seen).toContain(`Tool execution error: auth failed for ${REDACTED} on retry`);
  });

  it.each(SECRET_FORMATS)("$name thrown as a plain string", async ({ key }) => {
    const k = key();
    const { seen } = await runThrowing(() => `${k} was rejected`);
    expect(seen).not.toContain(k);
    expect(seen).toContain(`Tool execution error: ${REDACTED} was rejected`);
  });

  it.each(SECRET_FORMATS)("$name at the very end of the message", async ({ key }) => {
    const k = key();
    const { seen } = await runThrowing(() => new Error(`key=${k}`));
    expect(seen).not.toContain(k);
    expect(seen).toContain(`key=${REDACTED}`);
  });

  it.each(SECRET_FORMATS)("$name in a non-Error object's text", async ({ key }) => {
    const k = key();
    const thrown = { toString: (): string => `upstream said ${k}` };
    const { seen } = await runThrowing(() => thrown);
    expect(seen).not.toContain(k);
    expect(seen).toContain(`upstream said ${REDACTED}`);
  });
});

describe("tool error messages: several keys", () => {
  it("strips two keys from one error", async () => {
    const [a = "", b = ""] = allKeys();
    const { seen } = await runThrowing(() => new Error(`${a} and ${b}`));
    expect(seen).not.toContain(a);
    expect(seen).not.toContain(b);
    expect(seen).toContain(`${REDACTED} and ${REDACTED}`);
  });

  it("strips all five formats from one error", async () => {
    const keys = allKeys();
    const { seen } = await runThrowing(() => new Error(keys.join(", ")));
    for (const k of keys) expect(seen).not.toContain(k);
    expect(seen).toContain(Array(5).fill(REDACTED).join(", "));
  });

  it("strips a key from a JSON body quoted in the error", async () => {
    const k = allKeys()[2] ?? "";
    const { seen } = await runThrowing(() => new Error(JSON.stringify({ token: k, status: 401 })));
    expect(seen).not.toContain(k);
    expect(seen).toContain("401");
  });
});

describe("tool error messages: the run carries on", () => {
  it("still returns the redacted error to the model and finishes", async () => {
    const { seen, result } = await runThrowing(() => new Error(`bad ${allKeys()[0]}`));
    expect(seen).toContain('"is_error":true');
    expect(result.output).toBe("ok");
  });

  it("keeps an error with no key exactly as thrown", async () => {
    const { seen } = await runThrowing(() => new Error("task-runner skeleton is risk-free"));
    expect(seen).toContain("Tool execution error: task-runner skeleton is risk-free");
  });

  it.each(SECRET_FORMATS)("keeps the $name near miss in an error", async ({ nearMiss }) => {
    const n = nearMiss();
    const { seen } = await runThrowing(() => new Error(`saw ${n} here`));
    expect(seen).toContain(`saw ${n} here`);
  });

  it("keeps an empty error message as an empty message", async () => {
    const { seen, result } = await runThrowing(() => new Error(""));
    expect(seen).toContain('"content":"Tool execution error: "');
    expect(result.output).toBe("ok");
  });
});

// Gaps on main, recorded and not fixed (the fix is security code, so it is
// the owner's call). Each is a todo so no test asserts that a key gets through.
describe("tool error messages: known gaps on main", () => {
  it.todo("strips a key from an error a tool returns as { is_error: true } instead of throwing");
  it.todo("strips a Bearer token written as bearer or BEARER from a thrown error");
  it.todo("strips a Bearer token containing +, / or = from a thrown error");
  it.todo("strips sk-proj-, sk-svcacct- and sk-admin- keys from a thrown error");
});
