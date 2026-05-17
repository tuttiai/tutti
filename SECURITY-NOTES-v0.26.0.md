# Security notes — v0.26.0

`npm audit --audit-level=high` reports five open advisories at the time of
release. All sit in transitive dependencies of `@tuttiai/telemetry`. They
are not introduced by v0.26.0 — the OpenTelemetry chain was already in
place before this release — but the audit gate flagged them during the
release run, so we are publishing this release with the advisories
explicitly acknowledged and a fix scheduled.

## Advisories

| Package | Range | Severity | Advisory |
|---|---|---|---|
| `@opentelemetry/auto-instrumentations-node` | `<=0.74.0` | high | [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) — Prometheus exporter process crash via malformed HTTP request |
| `@opentelemetry/exporter-prometheus` | `<0.217.0` | high | [GHSA-q7rr-3cgh-j5r3](https://github.com/advisories/GHSA-q7rr-3cgh-j5r3) |
| `@opentelemetry/sdk-node` | `<=0.216.0` | high | transitive (via exporter-prometheus) |
| `protobufjs` | `<=7.5.5` | high | [GHSA-66ff-xgx4-vchm](https://github.com/advisories/GHSA-66ff-xgx4-vchm), [GHSA-2pr8-phx7-x9h3](https://github.com/advisories/GHSA-2pr8-phx7-x9h3), [GHSA-fx83-v9x8-x52w](https://github.com/advisories/GHSA-fx83-v9x8-x52w), [GHSA-75px-5xx7-5xc7](https://github.com/advisories/GHSA-75px-5xx7-5xc7), [GHSA-685m-2w69-288q](https://github.com/advisories/GHSA-685m-2w69-288q), [GHSA-jvwf-75h9-cwgg](https://github.com/advisories/GHSA-jvwf-75h9-cwgg) — code injection, DoS, prototype pollution |
| `@protobufjs/utf8` | `<=1.1.0` | moderate | [GHSA-q6x5-8v7m-xcrf](https://github.com/advisories/GHSA-q6x5-8v7m-xcrf) — overlong UTF-8 decoding |

## Why we are publishing despite these

1. **Exposure surface is narrow.** The Prometheus exporter advisories
   require the exporter to be reachable over HTTP. Tutti's default
   telemetry configuration does not enable the Prometheus exporter at
   all — `@tuttiai/telemetry` defaults to the OTLP/HTTP exporter, which
   is not affected. Users who explicitly opt into the Prometheus
   exporter and expose it on a public network should treat these
   advisories as live risks and consider mitigations until v0.26.1.
2. **The protobufjs advisories require attacker-controlled input.** The
   exploits chain through `.fromObject` / generated `toObject` code paths
   on attacker-supplied messages. Tutti uses protobuf only via the
   OpenTelemetry exporter's outbound traffic, where the messages are
   self-generated. No tutti-shaped code path receives untrusted protobuf
   input.
3. **The fix is a breaking change.** Clearing all four high advisories
   requires `@opentelemetry/sdk-node` ≥ 0.218.0 and
   `@opentelemetry/auto-instrumentations-node` ≥ 0.76.0. Both bumps
   change exporter configuration shape. Folding that into a release
   already shipping skills + scheduled delivery + serverless targets
   would have entangled three independent risk surfaces; we are keeping
   them separate.

## Fix schedule

The OpenTelemetry SDK upgrade lands in **v0.26.1**, planned for the next
sprint. That release will:

- Bump `@opentelemetry/sdk-node` to ≥ 0.218.0.
- Bump `@opentelemetry/auto-instrumentations-node` to ≥ 0.76.0 (clears
  the protobufjs transitive chain).
- Re-validate the exporter configuration shape in
  `@tuttiai/telemetry`'s `OtelTracer` against the new SDK API.
- Re-run `npm audit --audit-level=high` and require it clean.

## If you cannot wait

- Users who pin telemetry to a no-op tracer
  (`telemetry: { enabled: false }`) are unaffected.
- Users on OTLP/HTTP (the default exporter) are not exposed to
  GHSA-q7rr-3cgh-j5r3.
- Users on the Prometheus exporter can manually upgrade
  `@opentelemetry/exporter-prometheus` to ≥ 0.217.0 in their own
  `package.json` overrides; this clears that advisory without waiting
  for v0.26.1.

This document will be deleted when v0.26.1 ships clean.
