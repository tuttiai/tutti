---
"@tuttiai/telemetry": minor
---

Add an opt-in `semconv: "genai"` option to `OTLPExporter` that exports agent, LLM and tool spans with the OpenTelemetry GenAI semantic-convention names (`invoke_agent {agent}`, `chat {model}`, `execute_tool {tool}`) and `gen_ai.*` attributes. Export `GEN_AI_ATTRIBUTES`, `GEN_AI_OPERATIONS`, `genAiSpanNaming`, `legacySpanNaming` and their types. The default output is unchanged.
