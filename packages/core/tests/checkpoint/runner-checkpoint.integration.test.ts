import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  AgentConfig,
  ChatResponse,
  LLMProvider,
  StreamChunk,
  Tool,
  TuttiEvent,
} from "@tuttiai/types";
import { AgentRunner } from "../../src/agent-runner.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import { MemoryCheckpointStore } from "../../src/checkpoint/memory.js";

// ---------------------------------------------------------------------------
// Integration test — durable resume after a mid-run crash.
//
// NOTE ON THE CRASH MECHANISM:
// The spec asked for the crash to come from "throwing inside the tool
// handler", but AgentRunner.executeTool already catches thrown errors and
// converts them to `is_error: true` tool_result blocks (agent-runner.ts
// lines ~650-668) — the loop never sees them as exceptions. So we simulate
// the crash one layer up instead: the mock LLM provider throws on the
// third `chat()` call, which propagates cleanly out of the while loop.
// The test's assertions on turn numbering still hold.
// ---------------------------------------------------------------------------

/** Build a tool_use ChatResponse targeting the `noop` tool. */
function toolUseResponse(callIndex: number): ChatResponse {
  return {
    id: "resp-" + callIndex,
    content: [
      {
        type: "tool_use",
        id: "tool-" + callIndex,
        name: "noop",
        input: { n: callIndex },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function endTurnResponse(text: string): ChatResponse {
  return {
    id: "resp-end",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 4, output_tokens: 2 },
  };
}

describe("AgentRunner — durable checkpoint resume", () => {
  it("resumes from turn 3 after a crash during turn 3", async () => {
    const events = new EventBus();
    const sessions = new InMemorySessionStore();
    const checkpointStore = new MemoryCheckpointStore();

    // Pre-create a session so we can use the same id across both runs —
    // the first run crashes before returning an AgentResult to read it from.
    const session = sessions.create("test-agent");

    // Provider behaviour keyed off call index (survives across runs because
    // the closure is shared):
    //   call 1 → tool_use  (turn 1 starts)
    //   call 2 → tool_use  (turn 2 starts)
    //   call 3 → THROW     (turn 3 starts, crashes before assistant message)
    //   call 4 → end_turn  (first turn after resume — expected to be turn 3)
    let callCount = 0;
    const chat = vi.fn(async (): Promise<ChatResponse> => {
      callCount += 1;
      if (callCount === 1 || callCount === 2) return toolUseResponse(callCount);
      if (callCount === 3) {
        throw new Error("Simulated provider crash on turn 3");
      }
      return endTurnResponse("All done after resume.");
    });
    const provider: LLMProvider = {
      chat,
      // eslint-disable-next-line require-yield
      async *stream(): AsyncGenerator<StreamChunk> {
        throw new Error("streaming not used in this test");
      },
    };

    const tool: Tool = {
      name: "noop",
      description: "Always returns ok.",
      parameters: z.object({ n: z.number() }),
      execute: () => Promise.resolve({ content: "ok" }),
    };

    const agent: AgentConfig = {
      name: "test-agent",
      model: "test-model",
      system_prompt: "test",
      voices: [
        {
          name: "voice",
          tools: [tool],
          required_permissions: [],
        },
      ],
      // Opt in to durable checkpointing.
      durable: true,
    };

    const runner = new AgentRunner(
      provider,
      events,
      sessions,
      undefined,
      undefined,
      undefined,
      checkpointStore,
    );

    // Collect checkpoint events across both runs.
    const checkpointEvents: Array<{
      type: "checkpoint:saved" | "checkpoint:restored";
      turn: number;
    }> = [];
    events.onAny((ev: TuttiEvent) => {
      if (ev.type === "checkpoint:saved" || ev.type === "checkpoint:restored") {
        checkpointEvents.push({ type: ev.type, turn: ev.turn });
      }
    });

    // --- Run 1: crash on turn 3 ------------------------------------------
    await expect(
      runner.run(agent, "start the conversation", session.id),
    ).rejects.toThrow(/Simulated provider crash on turn 3/);

    // Two checkpoints should have been saved (turn 1 and turn 2), none
    // restored yet.
    expect(checkpointEvents).toEqual([
      { type: "checkpoint:saved", turn: 1 },
      { type: "checkpoint:saved", turn: 2 },
    ]);
    expect(chat).toHaveBeenCalledTimes(3);

    const stored = await checkpointStore.loadLatest(session.id);
    expect(stored).not.toBeNull();
    expect(stored?.turn).toBe(2);
    expect(stored?.state.awaiting_tool_results).toBe(true);
    // Usage accumulator should carry both turns' LLM responses.
    expect(stored?.state.prompt_tokens_used).toBe(20); // 10 + 10
    expect(stored?.state.completion_tokens_used).toBe(10); // 5 + 5

    // --- Run 2: resume from checkpoint(turn=2) ---------------------------
    checkpointEvents.length = 0;

    const result = await runner.run(agent, "start the conversation", session.id);

    // Exactly one more LLM call should have been made (the end_turn at
    // turn 3). Call counter goes from 3 (at crash) → 4 (resume call).
    expect(chat).toHaveBeenCalledTimes(4);

    // Resume fires `checkpoint:restored` with the last durable turn.
    // Since turn 3 ended cleanly (stop_reason=end_turn), no new
    // checkpoint is saved — checkpoints only fire at the mid-cycle
    // tool-use boundary.
    expect(checkpointEvents).toEqual([
      { type: "checkpoint:restored", turn: 2 },
    ]);

    // The run result reports turn 3 — i.e. the resume picked up where
    // turn 2 left off, not from turn 1.
    expect(result.turns).toBe(3);
    expect(result.session_id).toBe(session.id);
    expect(result.output).toBe("All done after resume.");

    // Token usage after resume = checkpointed counters + the final turn's
    // call = 20+4 / 10+2.
    expect(result.usage.input_tokens).toBe(24);
    expect(result.usage.output_tokens).toBe(12);
  });
});
