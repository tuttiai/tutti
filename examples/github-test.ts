import { TuttiRuntime, AnthropicProvider, defineScore } from "@tuttiai/core";
import { GitHubVoice } from "@tuttiai/github";

const score = defineScore({
  provider: new AnthropicProvider(),
  agents: {
    coder: {
      name: "coder",
      model: "claude-sonnet-4-20250514",
      system_prompt:
        "You are a helpful assistant with GitHub access. Use the tools to answer questions about repositories.",
      voices: [new GitHubVoice()],
    },
  },
});

const tutti = new TuttiRuntime(score);

tutti.events.on("tool:start", (e) => {
  console.log(`\n[tool] ${e.tool_name}`);
});
tutti.events.on("tool:end", (e) => {
  console.log(`[tool] ${e.tool_name} done (${e.result.content.length} chars)`);
});

console.log("Running GitHub voice test...\n");

const result = await tutti.run(
  "coder",
  "List the top 5 open issues in the vercel/next.js repository",
);

console.log("\n--- Result ---");
console.log("Output:", result.output);
console.log("Turns:", result.turns);
console.log(
  "Usage:",
  `${result.usage.input_tokens} input / ${result.usage.output_tokens} output tokens`,
);
