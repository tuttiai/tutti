import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { FilesystemVoice } from "@tuttiai/filesystem";

const score = defineScore({
  name: "filesystem-test",
  provider: new AnthropicProvider(),
  agents: {
    assistant: {
      name: "assistant",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a helpful assistant with filesystem access. Use the tools provided to complete tasks.",
      voices: [new FilesystemVoice()],
      permissions: ["filesystem"],
    },
  },
});

const tutti = new TuttiRuntime(score);

// Log all events
tutti.events.onAny((event) => {
  if (event.type === "tool:start") {
    console.log(`\n[tool] ${event.tool_name}`, JSON.stringify(event.input));
  } else if (event.type === "tool:end") {
    console.log(`[tool] ${event.tool_name} done:`, event.result.content);
  } else if (event.type === "tool:error") {
    console.log(`[tool] ${event.tool_name} ERROR:`, event.error.message);
  }
});

console.log("Running filesystem voice test...\n");

const result = await tutti.run(
  "assistant",
  "Create a file called hello.txt with the content 'Hello from Tutti!' then read it back to confirm.",
);

console.log("\n--- Result ---");
console.log("Output:", result.output);
console.log("Turns:", result.turns);
console.log(
  "Usage:",
  `${result.usage.input_tokens} input / ${result.usage.output_tokens} output tokens`,
);
