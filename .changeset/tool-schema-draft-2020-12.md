---
"@tuttiai/core": patch
---

Send tool schemas Anthropic accepts: exclusive bounds in draft 2020-12's form.

Tool parameters were converted with `zod-to-json-schema`'s `openApi3` target, which writes `z.number().positive()` as `{ minimum: 0, exclusiveMinimum: true }`, draft-04's form. Anthropic validates every tool against JSON Schema draft 2020-12 and refused the whole request with `tools.N.custom.input_schema: JSON schema is invalid`, so one `.positive()` in a voice made every agent holding it unusable: the `web` voice's `fetch_url` did exactly that. The bound is now rewritten as `{ exclusiveMinimum: 0 }` (and `exclusiveMaximum` likewise), which draft 2020-12 and OpenAPI 3.1 read the same way. The `openApi3` target stays, since the Gemini provider's translation relies on its shape. Both call sites, the agent runner and the skills executor, now share one converter.
