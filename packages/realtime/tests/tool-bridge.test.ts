import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  EventBus,
  MemoryInterruptStore,
  PermissionError,
} from "@tuttiai/core";
import type { AgentConfig, Tool, ToolResult } from "@tuttiai/types";

import { RealtimeClient } from "../src/client.js";
import { registerTools } from "../src/tool-bridge.js";
import type { RealtimeConfig } from "../src/types.js";
import { MockWebSocket } from "./mock-websocket.js";

const config: RealtimeConfig = {
  model: "gpt-4o-realtime-preview",
  voice: "alloy",
  turnDetection: { type: "server_vad" },
};

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "concierge",
    system_prompt: "You are helpful.",
    voices: [],
    permissions: ["network"],
    ...overrides,
  };
}

function makeEcho(): Tool<{ text: string }> & { calls: Array<{ text: string }> } {
  const calls: Array<{ text: string }> = [];
  const tool: Tool<{ text: string }> = {
    name: "echo",
    description: "Echo input text.",
    parameters: z.object({ text: z.string() }),
    execute: async (input): Promise<ToolResult> => {
      calls.push(input);
      return { content: `echoed:${input.text}` };
    },
  };
  return Object.assign(tool, { calls });
}

async function connectClient(): Promise<{ client: RealtimeClient; socket: MockWebSocket }> {
  const client = new RealtimeClient({ websocketCtor: MockWebSocket });
  const promise = client.connect("test-key", config);
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("expected mock socket");
  socket.fireOpen();
  await promise;
  // Drop the initial session.update emitted on connect so tests can
  // assert on the bridge's frames in isolation.
  socket.sent.length = 0;
  return { client, socket };
}

beforeEach(() => MockWebSocket.reset());
afterEach(() => MockWebSocket.reset());

describe("registerTools", () => {
  describe("permissions", () => {
    it("throws PermissionError when network is not granted", async () => {
      const { client } = await connectClient();
      const events = new EventBus();
      const agent = makeAgent({ permissions: [] });

      expect(() =>
        registerTools(client, [makeEcho()], agent, {
          events,
          session_id: "s1",
          agent_name: agent.name,
        }),
      ).toThrow(PermissionError);
    });

    it("throws PermissionError when permissions field is omitted", async () => {
      const { client } = await connectClient();
      const events = new EventBus();
      const agent = makeAgent();
      delete (agent as { permissions?: unknown }).permissions;

      expect(() =>
        registerTools(client, [makeEcho()], agent, {
          events,
          session_id: "s1",
          agent_name: agent.name,
        }),
      ).toThrow(PermissionError);
    });
  });

  describe("registration", () => {
    it("advertises tool definitions via session.update on register", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const agent = makeAgent();

      registerTools(client, [makeEcho()], agent, {
        events,
        session_id: "s1",
        agent_name: agent.name,
      });

      expect(socket.sent).toHaveLength(1);
      const payload = JSON.parse(socket.sent[0] ?? "");
      expect(payload.type).toBe("session.update");
      expect(payload.session.tools).toHaveLength(1);
      expect(payload.session.tools[0].name).toBe("echo");
      expect(payload.session.tools[0].type).toBe("function");
    });

    it("re-advertises on session.created (covers reconnect)", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();

      registerTools(client, [makeEcho()], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;
      socket.fireMessage(JSON.stringify({ type: "session.created" }));

      expect(socket.sent).toHaveLength(1);
      expect(JSON.parse(socket.sent[0] ?? "").type).toBe("session.update");
    });
  });

  describe("tool call interception", () => {
    it("executes a tool and writes function_call_output + response.create", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const echo = makeEcho();

      registerTools(client, [echo], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      // Allow the async runCall to settle.
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(echo.calls).toEqual([{ text: "hi" }]);
      expect(socket.sent).toHaveLength(2);
      const out = JSON.parse(socket.sent[0] ?? "");
      expect(out.type).toBe("conversation.item.create");
      expect(out.item.type).toBe("function_call_output");
      expect(out.item.call_id).toBe("call-1");
      expect(out.item.output).toBe("echoed:hi");
      expect(JSON.parse(socket.sent[1] ?? "").type).toBe("response.create");
    });

    it("returns an error result when the tool name is unknown", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();

      registerTools(client, [makeEcho()], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-2",
          name: "nope",
          arguments: "{}",
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));

      const out = JSON.parse(socket.sent[0] ?? "");
      expect(out.item.output).toContain("Unknown tool");
    });

    it("emits tool:start and tool:end on the EventBus", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const seen: string[] = [];
      events.onAny((e) => seen.push(e.type));

      registerTools(client, [makeEcho()], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(seen).toEqual(expect.arrayContaining(["tool:start", "tool:end"]));
    });
  });

  describe("secret redaction", () => {
    it("redacts API-key-shaped values in tool args before emitting tool:start", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      let seenInput: unknown = null;
      events.on("tool:start", (e) => {
        seenInput = e.input;
      });

      const sink: Tool<{ token: string }> = {
        name: "send",
        description: "Send a token.",
        parameters: z.object({ token: z.string() }),
        execute: async () => ({ content: "ok" }),
      };
      registerTools(client, [sink], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      const leaked = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "send",
          arguments: JSON.stringify({ token: leaked }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(JSON.stringify(seenInput)).not.toContain(leaked);
      expect(JSON.stringify(seenInput)).toContain("[REDACTED]");
    });

    it("redacts a leaked key in the wire frame sent back to the model", async () => {
      // EventBus.redactObject loses Error.message in its JSON round-trip
      // (Error fields are non-enumerable), so we assert end-to-end on
      // what the model actually sees: the function_call_output frame.
      const { client, socket } = await connectClient();
      const events = new EventBus();

      const leaked = "sk-abcdefghijklmnopqrstuvwxyz0123456789";
      const failing: Tool<{ x: string }> = {
        name: "leaky",
        description: "Throws with a leaked key.",
        parameters: z.object({ x: z.string() }),
        execute: async () => {
          throw new Error(`upstream returned 401 with key ${leaked}`);
        },
      };
      registerTools(client, [failing], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "leaky",
          arguments: JSON.stringify({ x: "ok" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(socket.sent.length).toBeGreaterThanOrEqual(1);
      const out = JSON.parse(socket.sent[0] ?? "");
      expect(out.item.output).not.toContain(leaked);
      expect(out.item.output).toContain("[REDACTED]");
    });
  });

  describe("requireApproval gating", () => {
    it("emits interrupt:requested and waits for approval before executing", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const interruptStore = new MemoryInterruptStore();
      const echo = makeEcho();

      const requested = vi.fn();
      events.on("interrupt:requested", requested);

      const bridge = registerTools(client, [echo], makeAgent({ requireApproval: ["echo"] }), {
        events,
        interruptStore,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      // Drain microtasks so the interruptStore.create promise resolves.
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(requested).toHaveBeenCalledTimes(1);
      expect(echo.calls).toHaveLength(0);

      const event = requested.mock.calls[0]?.[0] as { interrupt_id: string };
      await bridge.resolveInterrupt(event.interrupt_id, "approved");
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(echo.calls).toEqual([{ text: "hi" }]);
      expect(JSON.parse(socket.sent[0] ?? "").item.output).toBe("echoed:hi");
    });

    it("denies the call: tool does not execute and result is an error payload", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const interruptStore = new MemoryInterruptStore();
      const echo = makeEcho();

      const requested = vi.fn();
      events.on("interrupt:requested", requested);
      const bridge = registerTools(client, [echo], makeAgent({ requireApproval: "all" }), {
        events,
        interruptStore,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      const event = requested.mock.calls[0]?.[0] as { interrupt_id: string };
      await bridge.resolveInterrupt(event.interrupt_id, "denied", { denial_reason: "no" });
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(echo.calls).toHaveLength(0);
      expect(socket.sent[0]).toContain("denied");
    });

    it("emits interrupt:resolved on approval", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const interruptStore = new MemoryInterruptStore();

      const requested = vi.fn();
      const resolved = vi.fn();
      events.on("interrupt:requested", requested);
      events.on("interrupt:resolved", resolved);

      const bridge = registerTools(client, [makeEcho()], makeAgent({ requireApproval: "all" }), {
        events,
        interruptStore,
        session_id: "s1",
        agent_name: "concierge",
      });

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      const ev = requested.mock.calls[0]?.[0] as { interrupt_id: string };
      await bridge.resolveInterrupt(ev.interrupt_id, "approved");
      expect(resolved).toHaveBeenCalledTimes(1);
    });

    it("rejects pending approvals on dispose() with InterruptDeniedError-shaped flow", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const interruptStore = new MemoryInterruptStore();

      const errors = vi.fn();
      events.on("tool:error", errors);

      const bridge = registerTools(client, [makeEcho()], makeAgent({ requireApproval: "all" }), {
        events,
        interruptStore,
        session_id: "s1",
        agent_name: "concierge",
      });

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      bridge.dispose();
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(errors).toHaveBeenCalled();
    });

    it("denial routes an INTERRUPT_DENIED error into tool:error", async () => {
      // EventBus JSON-stringifies payloads for redaction, so the
      // listener sees a plain object — we assert on the serialized
      // `code` field that survives the round-trip.
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const interruptStore = new MemoryInterruptStore();

      const errors: Array<{ code?: string }> = [];
      events.on("tool:error", (e) => errors.push(e.error as unknown as { code?: string }));

      const requested = vi.fn();
      events.on("interrupt:requested", requested);

      const bridge = registerTools(client, [makeEcho()], makeAgent({ requireApproval: "all" }), {
        events,
        interruptStore,
        session_id: "s1",
        agent_name: "concierge",
      });

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      const ev = requested.mock.calls[0]?.[0] as { interrupt_id: string };
      await bridge.resolveInterrupt(ev.interrupt_id, "denied", { denial_reason: "blocked" });
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(errors[0]?.code).toBe("INTERRUPT_DENIED");
    });

    it("rejects when requireApproval matches but no InterruptStore is configured", async () => {
      // The bridge writes the redacted error message back to the model
      // as a function_call_output; the EventBus payload loses Error
      // fields in JSON round-trip, so we assert on the wire frame.
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const errors: Array<unknown> = [];
      events.on("tool:error", (e) => errors.push(e.error));

      registerTools(client, [makeEcho()], makeAgent({ requireApproval: "all" }), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));
      await new Promise<void>((r) => queueMicrotask(r));

      expect(errors).toHaveLength(1);
      const out = JSON.parse(socket.sent[0] ?? "");
      expect(out.item.output).toMatch(/InterruptStore/);
    });
  });

  describe("dispose", () => {
    it("stops further tool calls from running", async () => {
      const { client, socket } = await connectClient();
      const events = new EventBus();
      const echo = makeEcho();

      const bridge = registerTools(client, [echo], makeAgent(), {
        events,
        session_id: "s1",
        agent_name: "concierge",
      });
      bridge.dispose();
      socket.sent.length = 0;

      socket.fireMessage(
        JSON.stringify({
          type: "response.function_call_arguments.done",
          call_id: "call-1",
          name: "echo",
          arguments: JSON.stringify({ text: "hi" }),
        }),
      );
      await new Promise<void>((r) => queueMicrotask(r));

      expect(echo.calls).toHaveLength(0);
      expect(socket.sent).toHaveLength(0);
    });
  });
});
