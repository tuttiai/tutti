import { describe, it, expect, vi } from "vitest";
import { AgentRunner } from "../../src/agent-runner.js";
import { GuardrailError } from "../../src/errors.js";
import { EventBus } from "../../src/event-bus.js";
import { InMemorySessionStore } from "../../src/session-store.js";
import {
  createMockProvider,
  textResponse,
  simpleAgent,
} from "../helpers/mock-provider.js";

describe("AgentRunner — guardrail hooks", () => {
  describe("beforeRun", () => {
    it("passes modified input to the LLM when beforeRun returns a string", async () => {
      const provider = createMockProvider([textResponse("ok")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const beforeRun = vi.fn(async (text: string) => text.replace("bad", "[redacted]"));

      await runner.run(
        { ...simpleAgent, beforeRun },
        "This is bad input",
      );

      expect(beforeRun).toHaveBeenCalledOnce();
      // The LLM should receive the modified input
      const request = provider.chat.mock.calls[0]?.[0];
      const userMsg = request?.messages?.[0];
      expect(userMsg?.content).toBe("This is [redacted] input");
    });

    it("uses original input when beforeRun returns void", async () => {
      const provider = createMockProvider([textResponse("ok")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const beforeRun = vi.fn(async () => undefined);

      await runner.run(
        { ...simpleAgent, beforeRun },
        "original input",
      );

      const request = provider.chat.mock.calls[0]?.[0];
      const userMsg = request?.messages?.[0];
      expect(userMsg?.content).toBe("original input");
    });

    it("aborts the run when beforeRun throws GuardrailError", async () => {
      const provider = createMockProvider([textResponse("ok")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const beforeRun = vi.fn(async () => {
        throw new GuardrailError("Input blocked", { guardrail: "test" });
      });

      await expect(
        runner.run({ ...simpleAgent, beforeRun }, "hello"),
      ).rejects.toThrow(GuardrailError);

      // LLM should never be called
      expect(provider.chat).not.toHaveBeenCalled();
    });
  });

  describe("afterRun", () => {
    it("returns modified output when afterRun returns a string", async () => {
      const provider = createMockProvider([textResponse("output with bad word")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const afterRun = vi.fn(async (text: string) => text.replace("bad", "[filtered]"));

      const result = await runner.run(
        { ...simpleAgent, afterRun },
        "hello",
      );

      expect(afterRun).toHaveBeenCalledOnce();
      expect(result.output).toBe("output with [filtered] word");
    });

    it("returns original output when afterRun returns void", async () => {
      const provider = createMockProvider([textResponse("safe output")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const afterRun = vi.fn(async () => undefined);

      const result = await runner.run(
        { ...simpleAgent, afterRun },
        "hello",
      );

      expect(result.output).toBe("safe output");
    });

    it("throws when afterRun throws GuardrailError", async () => {
      const provider = createMockProvider([textResponse("toxic output")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const afterRun = vi.fn(async () => {
        throw new GuardrailError("Output blocked", { guardrail: "test" });
      });

      await expect(
        runner.run({ ...simpleAgent, afterRun }, "hello"),
      ).rejects.toThrow(GuardrailError);
    });

    it("receives the correct RunContext", async () => {
      const provider = createMockProvider([textResponse("ok")]);
      const events = new EventBus();
      const sessions = new InMemorySessionStore();
      const runner = new AgentRunner(provider, events, sessions);

      const afterRun = vi.fn(async () => undefined);

      await runner.run({ ...simpleAgent, afterRun }, "hello");

      const [, ctx] = afterRun.mock.calls[0]!;
      expect(ctx.agent_name).toBe("test-agent");
      expect(ctx.session_id).toBeDefined();
    });
  });
});
