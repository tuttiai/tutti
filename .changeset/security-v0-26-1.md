---
"@tuttiai/core": patch
"@tuttiai/telemetry": patch
---

Clear the five OpenTelemetry / protobufjs advisories acknowledged in `SECURITY-NOTES-v0.26.0.md`.

- `@tuttiai/core`: bump `@opentelemetry/sdk-node` `^0.214.0` → `^0.218.0`, `@opentelemetry/auto-instrumentations-node` `^0.72.0` → `^0.76.0`, `@opentelemetry/exporter-trace-otlp-http` `^0.214.0` → `^0.218.0`. Clears [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) (Prometheus exporter process crash via malformed HTTP request) and the protobufjs transitive chain ([GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm), [GHSA-2pr8-phx7-x9h3](https://github.com/advisories/GHSA-2pr8-phx7-x9h3), [GHSA-fx83-v9x8-x52w](https://github.com/advisories/GHSA-fx83-v9x8-x52w), [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7), [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q), [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg), [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf)).
- `@tuttiai/telemetry`: bump `@opentelemetry/otlp-transformer` `^0.214.0` → `^0.218.0` to keep the OpenTelemetry contrib set on a single coherent version.

The exporter-configuration shape was forecast as a breaking change in `SECURITY-NOTES-v0.26.0.md` — `NodeSDK`, `getNodeAutoInstrumentations`, and `OTLPTraceExporter` constructor signatures in `packages/core/src/telemetry-setup.ts` continue to compile and pass the existing telemetry tests against 0.218.0 / 0.76.0 unchanged. No public-API change.
