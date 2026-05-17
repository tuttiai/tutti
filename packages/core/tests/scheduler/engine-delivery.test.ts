/**
 * Integration tests for the engine ↔ dispatch wiring. We mock both
 * `delivery.js` (the registration-time voice presence check) and
 * `dispatch.js` (the delivery-time outbound send) so the engine logic
 * can be exercised without loading any real voice peer dependency.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/scheduler/delivery.js", () => ({
  assertDeliveryVoiceInstalled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/scheduler/dispatch.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/scheduler/dispatch.js")>(
    "../../src/scheduler/dispatch.js",
  );
  return {
    ...actual,
    deliverScheduleResult: vi.fn(),
  };
});

import { SchedulerEngine } from "../../src/scheduler/engine.js";
import { MemoryScheduleStore } from "../../src/scheduler/memory.js";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { deliverScheduleResult } from "../../src/scheduler/dispatch.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";
import type { TuttiEvent } from "@tuttiai/types";

const deliverMock = vi.mocked(deliverScheduleResult);

function buildEngine(): {
  engine: SchedulerEngine;
  events: EventBus;
  store: MemoryScheduleStore;
} {
  const provider = createMockProvider([textResponse("hello world")]);
  const events = new EventBus();
  const sessions = new InMemorySessionStore();
  const runner = new AgentRunner(provider, events, sessions);
  const store = new MemoryScheduleStore();
  const engine = new SchedulerEngine(store, runner, events);
  return { engine, events, store };
}

beforeEach(() => {
  deliverMock.mockReset();
});

describe("SchedulerEngine — delivery", () => {
  it("calls deliverScheduleResult with the agent's output on success", async () => {
    deliverMock.mockResolvedValueOnce(undefined);
    const { engine } = buildEngine();
    await engine.schedule("sch", simpleAgent, {
      every: "1h",
      input: "go",
      deliver: { platform: "slack", channel: "#alerts" },
      deliver_format: "markdown",
    });
    engine.start();

    await engine.trigger("sch");

    expect(deliverMock).toHaveBeenCalledOnce();
    const call = deliverMock.mock.calls[0]?.[0];
    expect(call?.target).toEqual({ platform: "slack", channel: "#alerts" });
    expect(call?.content).toBe("hello world");
    expect(call?.format).toBe("markdown");
    expect(call?.agentName).toBe(simpleAgent.name);

    engine.stop();
  });

  it("emits schedule:delivered after a successful dispatch", async () => {
    deliverMock.mockResolvedValueOnce(undefined);
    const { engine, events } = buildEngine();
    const captured: TuttiEvent[] = [];
    events.onAny((e) => captured.push(e));

    await engine.schedule("sch", simpleAgent, {
      every: "1h",
      input: "go",
      deliver: { platform: "telegram", chat_id: "42" },
    });
    engine.start();
    await engine.trigger("sch");

    const delivered = captured.find((e) => e.type === "schedule:delivered");
    expect(delivered).toBeDefined();
    if (delivered?.type !== "schedule:delivered") throw new Error("type narrow");
    expect(delivered.platform).toBe("telegram");
    expect(delivered.target).toBe("42");
    expect(delivered.chars).toBe("hello world".length);

    engine.stop();
  });

  it("emits schedule:delivery_failed on dispatch error and does not crash", async () => {
    deliverMock.mockRejectedValueOnce(new Error("channel_not_found"));
    const { engine, events } = buildEngine();
    const captured: TuttiEvent[] = [];
    events.onAny((e) => captured.push(e));

    await engine.schedule("sch", simpleAgent, {
      every: "1h",
      input: "go",
      deliver: { platform: "discord", channel_id: "999" },
    });
    engine.start();

    // trigger() must NOT throw — delivery failures are absorbed.
    const run = await engine.trigger("sch");
    expect(run.error).toBeUndefined();
    expect(run.result).toBe("hello world");

    const failed = captured.find((e) => e.type === "schedule:delivery_failed");
    expect(failed).toBeDefined();
    if (failed?.type !== "schedule:delivery_failed") throw new Error("type narrow");
    expect(failed.platform).toBe("discord");
    expect(failed.target).toBe("999");
    expect(failed.error).toContain("channel_not_found");

    engine.stop();
  });

  it("skips delivery entirely when config.deliver is not set", async () => {
    const { engine } = buildEngine();
    await engine.schedule("sch", simpleAgent, { every: "1h", input: "go" });
    engine.start();
    await engine.trigger("sch");
    expect(deliverMock).not.toHaveBeenCalled();
    engine.stop();
  });

  it("defaults format to 'text' when deliver_format is unset", async () => {
    deliverMock.mockResolvedValueOnce(undefined);
    const { engine } = buildEngine();
    await engine.schedule("sch", simpleAgent, {
      every: "1h",
      input: "go",
      deliver: { platform: "email", to: "user@example.com" },
    });
    engine.start();
    await engine.trigger("sch");

    expect(deliverMock.mock.calls[0]?.[0]?.format).toBe("text");
    engine.stop();
  });
});
