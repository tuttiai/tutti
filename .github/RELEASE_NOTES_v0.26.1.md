## v0.26.1 — Security patch: clear OpenTelemetry / protobufjs advisories.

v0.26.1 ships only one thing: it clears the five GitHub Security Advisories
acknowledged in `SECURITY-NOTES-v0.26.0.md` (four high, one moderate) plus a
`devalue` DoS advisory that surfaced under `docs/` after v0.26.0 shipped — 14
open Dependabot alerts on `tuttiai/tutti` in total. `npm audit
--audit-level=high` is now clean across the root workspace and the docs site.

No new features, no behaviour changes. Drop-in for any v0.26.0 install.

## Advisories cleared

| Package | Range | Severity | Advisory |
|---|---|---|---|
| `@opentelemetry/auto-instrumentations-node` | `<0.75.0` | high | [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) — Prometheus exporter process crash via malformed HTTP request |
| `@opentelemetry/sdk-node` | `<0.217.0` | high | transitive (Prometheus exporter crash) |
| `@opentelemetry/exporter-prometheus` | `<0.217.0` | high | transitive (Prometheus exporter crash) |
| `protobufjs` | `<=7.5.5` | high / moderate | code injection, DoS, prototype pollution — seven CVEs ([GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm), [GHSA-2pr8-phx7-x9h3](https://github.com/advisories/GHSA-2pr8-phx7-x9h3), [GHSA-fx83-v9x8-x52w](https://github.com/advisories/GHSA-fx83-v9x8-x52w), [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7), [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q), [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg), [GHSA-2qrj-frcc-jp5g](https://github.com/advisories/GHSA-2qrj-frcc-jp5g)) |
| `@protobufjs/utf8` | `<=1.1.0` | moderate | [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf) — overlong UTF-8 decoding |
| `devalue` | `>=5.6.3,<=5.8.0` | high | [GHSA-77vg-94rm-hx3p](https://github.com/advisories/GHSA-77vg-94rm-hx3p) — Svelte devalue DoS via sparse array deserialization (transitive in Astro under `docs/`) |

## Bumps

```diff
- "@opentelemetry/sdk-node":                  "^0.214.0"
+ "@opentelemetry/sdk-node":                  "^0.218.0"
- "@opentelemetry/auto-instrumentations-node": "^0.72.0"
+ "@opentelemetry/auto-instrumentations-node": "^0.76.0"
- "@opentelemetry/exporter-trace-otlp-http":   "^0.214.0"
+ "@opentelemetry/exporter-trace-otlp-http":   "^0.218.0"
- "@opentelemetry/otlp-transformer":           "^0.214.0"
+ "@opentelemetry/otlp-transformer":           "^0.218.0"
```

| Package | v0.26.0 | v0.26.1 |
|---|---|---|
| `@tuttiai/core` | 0.23.0 | **0.23.1** |
| `@tuttiai/telemetry` | 0.4.0 | **0.4.1** |
| All other packages | unchanged | unchanged |

## Compatibility

`SECURITY-NOTES-v0.26.0.md` forecast the OpenTelemetry 0.214 → 0.218 upgrade as
a breaking change to exporter-configuration shape. In practice the constructor
signatures for `NodeSDK`, `getNodeAutoInstrumentations`, and
`OTLPTraceExporter` used in `packages/core/src/telemetry-setup.ts` are
unchanged, and the existing telemetry tests pass against 0.218.0 / 0.76.0
without modification. No tutti public-API change; no migration required.

## Verifying the fix locally

```
npm install tutti-ai@0.26.1
npm audit --audit-level=high
# expected: found 0 vulnerabilities
```

## Removed

`SECURITY-NOTES-v0.26.0.md` is removed in this release. As that file stated:
"This document will be deleted when v0.26.1 ships clean."
