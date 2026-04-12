import { TuttiRuntime, AnthropicProvider, defineScore, createLogger } from "@tuttiai/core";

const logger = createLogger("example");

const score = defineScore({
  name: "basic-example",
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a friendly and concise assistant. Answer clearly in plain language.",
      voices: [],
    },
  },
});

const tutti = new TuttiRuntime(score);

// Subscribe to all events for full execution trace
tutti.events.onAny((event) => {
  const { type, ...data } = event;
  logger.debug({ event: type, ...data }, "Event emitted");
});

const result = await tutti.run(
  "assistant",
  "What is the capital of France? Answer in one sentence.",
);

logger.info({ output: result.output, turns: result.turns }, "Result");
logger.info(
  { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
  "Token usage",
);
logger.info({ session: result.session_id }, "Session");
