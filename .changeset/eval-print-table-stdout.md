---
"@tuttiai/core": patch
---

`printEvalTable` writes through `process.stdout.write` instead of `console.log`. The output is unchanged byte for byte; code that captured it by patching `console.log` must capture `process.stdout` instead. `printEvalTable`, `evalToJSON` and `evalToMarkdown` now have TSDoc.
