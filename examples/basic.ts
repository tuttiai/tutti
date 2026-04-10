import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";

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
  console.log(`\n[event] ${type}`, JSON.stringify(data, null, 2));
});

const result = await tutti.run(
  "assistant",
  "What is the capital of France? Answer in one sentence.",
);

console.log("\n--- Result ---");
console.log("Output:", result.output);
console.log("Turns:", result.turns);
console.log(
  "Usage:",
  `${result.usage.input_tokens} input / ${result.usage.output_tokens} output tokens`,
);
console.log("Session:", result.session_id);
