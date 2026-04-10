import type { LLMProvider } from "@tuttiai/core";
import { AnthropicProvider, OpenAIProvider, GeminiProvider } from "@tuttiai/core";

// Type-check: all three implement LLMProvider
const providers: { name: string; create: () => LLMProvider }[] = [
  {
    name: "AnthropicProvider",
    create: () => new AnthropicProvider({ api_key: "test" }),
  },
  {
    name: "OpenAIProvider",
    create: () => new OpenAIProvider({ api_key: "test" }),
  },
  {
    name: "GeminiProvider",
    create: () => new GeminiProvider({ api_key: "test" }),
  },
];

for (const { name, create } of providers) {
  const provider = create();
  const hasChat = typeof provider.chat === "function";
  console.log(`  ${hasChat ? "✔" : "✘"} ${name} implements LLMProvider.chat()`);
}

console.log("\nAll providers loaded successfully");
