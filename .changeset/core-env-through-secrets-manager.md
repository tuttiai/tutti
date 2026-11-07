---
"@tuttiai/core": patch
---

Read `DATABASE_URL`, `TUTTI_LOG_LEVEL`, `NODE_ENV` and `OTEL_SERVICE_NAME` through `SecretsManager.optional()` instead of `process.env`, with the same defaults and results.
