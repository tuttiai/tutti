import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { MemoryInterruptStore } from "../../src/interrupt/memory-store.js";
import {
  createMockProvider,
  textResponse,
  toolUseResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";
import type { AgentConfig, TuttiEvent, Voice } from "@tuttiai/types";

/**
 * Build a tool voice whose `execute` is a spy we can assert on. The
 * spy rejects by default (to make unapproved runs visible) and can be
 * reconfigured per-test.
 */
function buildToolVoice(
  name: string,
  options: { destructive?: boolean } = {},
): {
  voice: Voice;
  execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (_input: unknown) => ({ content: "ok from " + name }));
  const voice: Voice = {
    name: "test-voice",
    required_permissions: [],
    tools: [
      {
        name,
        description: "Does a thing",
        parameters: z.object({ to: z.string() }),
        execute,
        ...(options.destructive !== undefined ? { destructive: options.destructive } : {}),
      },
    ],
  };
  return { voice, execute };
}

function approvalAgent(
  requireApproval: AgentConfig["requireApproval"],
  voice: Voice,
): AgentConfig {
  return { ...simpleAgent, voices: [voice], requireApproval };
}

describe("AgentRunner — requireApproval end-to-end", () => {
  it("emits interrupt:requested and pauses until resolveInterrupt is called with approved", async () => {
    const { voice, execute } = buildToolVoice("send_email");

    const provider = createMockProvider([
      toolUseResponse("send_email", { to: "alex@example.com" }),
      textResponse("Sent!"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    // Subscribe BEFORE run() so we don't race the event.
    const interrupts: TuttiEvent[] = [];
    events.onAny((e) => {
      if (e.type === "interrupt:requested" || e.type === "interrupt:resolved") {
        interrupts.push(e);
      }
    });

    // Start the run but don't await yet.
    const runPromise = runner.run(approvalAgent(["send_*"], voice), "please email alex");

    // Poll briefly until the interrupt is pending. A single setImmediate
    // isn't enough — the runner has several awaits before the tool gate.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const pending = await store.listPending();
      if (pending.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const pending = await store.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tool_name).toBe("send_email");
    expect(pending[0]!.tool_args).toEqual({ to: "alex@example.com" });
    expect(pending[0]!.status).toBe("pending");

    // Tool execute must NOT have run yet.
    expect(execute).not.toHaveBeenCalled();

    // Approve — the run should now complete.
    await runner.resolveInterrupt(pending[0]!.interrupt_id, "approved", {
      resolved_by: "reviewer-1",
    });

    const result = await runPromise;
    expect(result.output).toBe("Sent!");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      { to: "alex@example.com" },
      expect.objectContaining({ agent_name: "test-agent" }),
    );

    // Both lifecycle events fired, in order.
    expect(interrupts.map((e) => e.type)).toEqual([
      "interrupt:requested",
      "interrupt:resolved",
    ]);
    const resolved = interrupts[1] as Extract<TuttiEvent, { type: "interrupt:resolved" }>;
    expect(resolved.status).toBe("approved");
    expect(resolved.resolved_by).toBe("reviewer-1");
  });

  it("rejects the run with InterruptDeniedError when the operator denies", async () => {
    const { voice, execute } = buildToolVoice("delete_user");

    const provider = createMockProvider([
      toolUseResponse("delete_user", { to: "u-42" }),
      textResponse("unreachable"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const runPromise = runner.run(approvalAgent(["delete_*"], voice), "zap it");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const pending = await store.listPending();
      if (pending.length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [pending] = await store.listPending();
    expect(pending).toBeDefined();

    await runner.resolveInterrupt(pending!.interrupt_id, "denied", {
      denial_reason: "Wrong account",
    });

    await expect(runPromise).rejects.toMatchObject({
      name: "InterruptDeniedError",
      tool_name: "delete_user",
      reason: "Wrong account",
      interrupt_id: pending!.interrupt_id,
    });

    // Execute never ran.
    expect(execute).not.toHaveBeenCalled();

    // Error carries the fields we advertise.
    try {
      await runner.run(approvalAgent(["delete_*"], voice), "ignored");
    } catch {
      // irrelevant — just verifying the class is exported correctly above.
    }
  });

  it("'all' gates every tool call", async () => {
    const { voice, execute } = buildToolVoice("read_file");

    const provider = createMockProvider([
      toolUseResponse("read_file", { to: "/a" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const runPromise = runner.run(approvalAgent("all", voice), "read it");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await store.listPending()).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [pending] = await store.listPending();
    expect(pending).toBeDefined();
    expect(pending!.tool_name).toBe("read_file"); // 'all' matched, not a pattern

    expect(execute).not.toHaveBeenCalled();

    await runner.resolveInterrupt(pending!.interrupt_id, "approved");
    await expect(runPromise).resolves.toMatchObject({ output: "done" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("non-matching tools pass through without approval", async () => {
    const { voice, execute } = buildToolVoice("read_file");

    const provider = createMockProvider([
      toolUseResponse("read_file", { to: "/a" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    // Pattern only matches "send_*" / "delete_*" — read_file is not gated.
    const result = await runner.run(
      approvalAgent(["send_*", "delete_*"], voice),
      "read it",
    );
    expect(result.output).toBe("done");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.listPending()).toEqual([]);
  });

  it("requireApproval=false (the default) never creates interrupts", async () => {
    const { voice, execute } = buildToolVoice("send_email");

    const provider = createMockProvider([
      toolUseResponse("send_email", { to: "alex@example.com" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    // Even with the store attached, no gate means no interrupts.
    await runner.run(approvalAgent(false, voice), "send");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.listPending()).toEqual([]);
  });

  it("throws a clear error when a tool matches but no InterruptStore is configured", async () => {
    const { voice } = buildToolVoice("send_email");

    const provider = createMockProvider([
      toolUseResponse("send_email", { to: "alex@example.com" }),
      textResponse("recovered"),
    ]);
    // Construct the runner WITHOUT an InterruptStore.
    const runner = new AgentRunner(
      provider,
      new EventBus(),
      new InMemorySessionStore(),
    );

    // The underlying Error surfaces as a tool_result error (the
    // agent-runner's catch converts any throw from execute into one),
    // and the run continues so the LLM can react. Assert on the
    // observable: the follow-up turn happens and the output string is
    // what the second mock response returned.
    const result = await runner.run(approvalAgent(["send_*"], voice), "send");
    expect(result.output).toBe("recovered");

    const toolResult = result.messages.find((m) => {
      if (typeof m.content === "string") return false;
      return m.content.some(
        (b) => b.type === "tool_result" && b.is_error === true,
      );
    });
    expect(toolResult).toBeDefined();
  });

  it("resolveInterrupt throws when no InterruptStore is configured", async () => {
    const runner = new AgentRunner(
      createMockProvider([textResponse("noop")]),
      new EventBus(),
      new InMemorySessionStore(),
    );
    await expect(runner.resolveInterrupt("anything", "approved")).rejects.toThrow(
      /no InterruptStore is configured/,
    );
  });

  it("resolveInterrupt is idempotent (a second call is a no-op)", async () => {
    const { voice } = buildToolVoice("send_email");

    const provider = createMockProvider([
      toolUseResponse("send_email", { to: "a@b" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const runPromise = runner.run(approvalAgent(["send_*"], voice), "send");
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await store.listPending()).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const [pending] = await store.listPending();

    await runner.resolveInterrupt(pending!.interrupt_id, "approved", { resolved_by: "first" });
    // Second call with different status should NOT affect the record.
    const second = await runner.resolveInterrupt(pending!.interrupt_id, "denied", {
      denial_reason: "too late",
    });
    expect(second.status).toBe("approved"); // unchanged
    expect(second.resolved_by).toBe("first");

    await expect(runPromise).resolves.toBeDefined();
  });
});

describe("AgentRunner — destructive tool gating", () => {
  it("gates a destructive tool with no requireApproval config", async () => {
    const { voice, execute } = buildToolVoice("post_tweet", { destructive: true });

    const provider = createMockProvider([
      toolUseResponse("post_tweet", { to: "hello world" }),
      textResponse("Done!"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    // No requireApproval on this agent — destructive flag alone should gate.
    const agent: AgentConfig = { ...simpleAgent, voices: [voice] };
    const runPromise = runner.run(agent, "post that");

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if ((await store.listPending()).length > 0) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const [pending] = await store.listPending();
    expect(pending).toBeDefined();
    expect(pending!.tool_name).toBe("post_tweet");
    expect(execute).not.toHaveBeenCalled();

    await runner.resolveInterrupt(pending!.interrupt_id, "approved");
    await expect(runPromise).resolves.toMatchObject({ output: "Done!" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("does NOT gate destructive tools when requireApproval=false (explicit opt-out)", async () => {
    const { voice, execute } = buildToolVoice("post_tweet", { destructive: true });

    const provider = createMockProvider([
      toolUseResponse("post_tweet", { to: "yolo" }),
      textResponse("done"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    // Operator has explicitly opted out — destructive flag must not re-gate.
    const agent: AgentConfig = {
      ...simpleAgent,
      voices: [voice],
      requireApproval: false,
    };
    await runner.run(agent, "go");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.listPending()).toEqual([]);
  });

  it("leaves non-destructive tools ungated when no requireApproval config is set", async () => {
    const { voice, execute } = buildToolVoice("read_file", { destructive: false });

    const provider = createMockProvider([
      toolUseResponse("read_file", { to: "/a" }),
      textResponse("read"),
    ]);
    const events = new EventBus();
    const store = new MemoryInterruptStore();
    const runner = new AgentRunner(
      provider,
      events,
      new InMemorySessionStore(),
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const agent: AgentConfig = { ...simpleAgent, voices: [voice] };
    await runner.run(agent, "read it");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(await store.listPending()).toEqual([]);
  });
});
