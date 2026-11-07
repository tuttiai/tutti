/**
 * Keys in the five supported formats are stripped from event payloads
 * before any listener, and so any telemetry or UI that forwards them to a
 * model, can read them. Drives the real `EventBus` and `AgentRunner` on
 * main; `SecretsManager` is not mocked.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { TuttiEvent, Voice } from "@tuttiai/types";
import { AgentRunner } from "../src/agent-runner.js";
import { EventBus } from "../src/event-bus.js";
import { InMemorySessionStore } from "../src/session-store.js";
import { createMockProvider, simpleAgent, textResponse, toolUseResponse } from "./helpers/mock-provider.js";
import { PLAIN_WORDS, REDACTED, SECRET_FORMATS } from "./helpers/secret-fixtures.js";

function emitAndCollect(event: TuttiEvent): TuttiEvent[] {
  const bus = new EventBus();
  const received: TuttiEvent[] = [];
  bus.onAny((e) => received.push(e));
  bus.emit(event);
  return received;
}

function toolEnd(content: string): TuttiEvent {
  return { type: "tool:end", agent_name: "a", tool_name: "fetch", result: { content } };
}

const allKeys = (): string[] => SECRET_FORMATS.map((f) => f.key());

describe("event payloads: each format is stripped", () => {
  it.each(SECRET_FORMATS)("$name inside a longer string", ({ key }) => {
    const [event] = emitAndCollect(toolEnd(`token ${key()} expired`));
    expect(event).toEqual(toolEnd(`token ${REDACTED} expired`));
  });

  it.each(SECRET_FORMATS)("$name as the whole string", ({ key }) => {
    const [event] = emitAndCollect(toolEnd(key()));
    expect(event).toEqual(toolEnd(REDACTED));
  });

  it.each(SECRET_FORMATS)("$name at the start and at the end", ({ key }) => {
    const [event] = emitAndCollect(toolEnd(`${key()} then ${key()}`));
    expect(event).toEqual(toolEnd(`${REDACTED} then ${REDACTED}`));
  });

  it.each(SECRET_FORMATS)("$name in quotes, JSON and a URL query", ({ key }) => {
    const k = key();
    const text = `"${k}" {"auth":"${k}"} https://x.test/v1?key=${k}&q=1`;
    const [event] = emitAndCollect(toolEnd(text));
    const want = `"${REDACTED}" {"auth":"${REDACTED}"} https://x.test/v1?key=${REDACTED}&q=1`;
    expect(event).toEqual(toolEnd(want));
  });

  it.each(SECRET_FORMATS)("$name in a hitl:answered event", ({ key }) => {
    const sent: TuttiEvent = { type: "hitl:answered", agent_name: "a", session_id: "s", answer: `use ${key()}` };
    const [event] = emitAndCollect(sent);
    expect(event).toEqual({ ...sent, answer: `use ${REDACTED}` });
  });

  it.each(SECRET_FORMATS)("$name in a whole token:stream chunk", ({ key }) => {
    const sent: TuttiEvent = { type: "token:stream", agent_name: "a", session_id: "s", text: `${key()} ` };
    const [event] = emitAndCollect(sent);
    expect(event).toEqual({ ...sent, text: `${REDACTED} ` });
  });
});

describe("event payloads: several and nested keys", () => {
  it("strips all five formats from one payload", () => {
    const [event] = emitAndCollect(toolEnd(allKeys().join(" | ")));
    expect(event).toEqual(toolEnd(Array(5).fill(REDACTED).join(" | ")));
  });

  it("strips keys nested in objects and arrays of an llm:request", () => {
    const keys = allKeys();
    const sent: TuttiEvent = {
      type: "llm:request",
      agent_name: "a",
      request: {
        system: `system ${keys[0]}`,
        stop_sequences: [keys[1] ?? "", "end"],
        messages: [
          { role: "user", content: `first ${keys[2]}` },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: `${keys[3]} and ${keys[4]}` }] },
        ],
      },
    };
    const [event] = emitAndCollect(sent);
    const text = JSON.stringify(event);
    for (const k of keys) expect(text).not.toContain(k);
    expect(text.split(REDACTED)).toHaveLength(6);
    expect(text).toContain("system ");
    expect(text).toContain('"end"');
  });

  it("delivers the same redacted event to typed and wildcard listeners", () => {
    const bus = new EventBus();
    const typed: string[] = [];
    const any: TuttiEvent[] = [];
    bus.on("tool:end", (e) => typed.push(e.result.content));
    bus.onAny((e) => any.push(e));
    bus.emit(toolEnd(allKeys().join(" ")));
    expect(typed).toEqual([Array(5).fill(REDACTED).join(" ")]);
    expect(any).toEqual([toolEnd(typed[0] ?? "")]);
  });
});

describe("event payloads: what must survive", () => {
  it.each(SECRET_FORMATS)("leaves the $name near miss unchanged", ({ nearMiss }) => {
    const sent = toolEnd(`x ${nearMiss()} y`);
    expect(emitAndCollect(sent)).toEqual([sent]);
  });

  it.each(PLAIN_WORDS)("leaves the plain words %s unchanged", (word) => {
    const sent = toolEnd(word);
    expect(emitAndCollect(sent)).toEqual([sent]);
  });

  it("leaves numbers, empty strings and absent fields unchanged", () => {
    const turn: TuttiEvent = { type: "turn:start", agent_name: "a", session_id: "", turn: 0 };
    const empty = toolEnd("");
    expect(emitAndCollect(turn)).toEqual([turn]);
    expect(emitAndCollect(empty)).toEqual([empty]);
    expect(emitAndCollect(empty)[0]).not.toHaveProperty("result.is_error");
  });
});

describe("event payloads from a real run", () => {
  function runWith(execute: () => Promise<{ content: string }>): Promise<TuttiEvent[]> {
    const voice: Voice = {
      name: "leaky",
      required_permissions: [],
      tools: [{ name: "leak", description: "leaks", parameters: z.object({}), execute }],
    };
    const bus = new EventBus();
    const events: TuttiEvent[] = [];
    bus.onAny((e) => events.push(e));
    const provider = createMockProvider([toolUseResponse("leak", {}), textResponse("ok")]);
    const runner = new AgentRunner(provider, bus, new InMemorySessionStore());
    return runner.run({ ...simpleAgent, voices: [voice] }, "go").then(() => events);
  }

  it("strips every format from the tool:end a tool produces", async () => {
    const keys = allKeys();
    const events = await runWith(async () => ({ content: keys.join(" ") }));
    const end = events.find((e) => e.type === "tool:end");
    expect(end).toMatchObject({ tool_name: "leak", result: { content: Array(5).fill(REDACTED).join(" ") } });
    const text = JSON.stringify(events);
    for (const k of keys) expect(text).not.toContain(k);
  });

  it("emits tool:error for a throwing tool without any key in it", async () => {
    const keys = allKeys();
    const events = await runWith(async () => {
      throw new Error(`denied ${keys.join(" ")}`);
    });
    expect(events.some((e) => e.type === "tool:error" && e.tool_name === "leak")).toBe(true);
    const text = JSON.stringify(events);
    for (const k of keys) expect(text).not.toContain(k);
  });
});

// Gaps on main, recorded and not fixed (the fix is security code, so it is
// the owner's call). Each is a todo so no test asserts that a key gets through.
describe("event payloads: known gaps on main", () => {
  it.todo("strips a Bearer token written as bearer or BEARER (the pattern is case-sensitive)");
  it.todo("strips a Bearer token containing +, / or = (base64 tokens survive whole or in part)");
  it.todo("strips sk-proj-, sk-svcacct- and sk-admin- keys (the hyphen after the prefix stops the sk- pattern)");
  it.todo("strips a key split across two token:stream chunks (each chunk is redacted alone)");
});
