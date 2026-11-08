---
"@tuttiai/server": patch
---

The error handler reads `NODE_ENV` through `SecretsManager.optional()` instead of `process.env`; only `"production"` still hides the message and stack of a 500.
