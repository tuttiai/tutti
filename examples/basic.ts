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
      streaming: true,
    },
  },
});

const tutti = new TuttiRuntime(score);

// Stream tokens to stdout in real-time
tutti.events.on("token:stream", (e) => {
  process.stdout.write(e.text);
});

const result = await tutti.run(
  "assistant",
  "What is the capital of France? Answer in one sentence.",
);

// Newline after streamed output
console.log();

logger.info({ turns: result.turns }, "Done");
logger.info(
  { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
  "Token usage",
);
logger.info({ session: result.session_id }, "Session");
