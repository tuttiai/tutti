# @tuttiai/discord

## 0.1.2

### Patch Changes

- Clear every high and critical npm advisory across the monorepo.

  `npm audit --audit-level=high` is a release gate in the engineering standards and had drifted red
  again since v0.26.1: 58 advisories, 22 high and 2 critical. It now exits 0, with 3 left in total
  (1 low, 2 moderate).

  - `@tuttiai/core`: `@opentelemetry/sdk-node` `^0.218.0` → `^0.222.0`,
    `@opentelemetry/exporter-trace-otlp-http` `^0.218.0` → `^0.222.0`,
    `@opentelemetry/auto-instrumentations-node` `^0.76.0` → `^0.80.0`.
  - `@tuttiai/telemetry`: `@opentelemetry/otlp-transformer` `^0.218.0` → `^0.222.0`, keeping the
    OpenTelemetry contrib set on one coherent version.

  Together these clear the whole OpenTelemetry chain — `@opentelemetry/propagator-jaeger`,
  `@grpc/grpc-js` and `protobufjs` — which reached every package that peer-depends on
  `@tuttiai/core`, including voices carrying no OpenTelemetry dependency of their own. v0.26.0
  forecast this upgrade as a breaking change to the exporter-configuration shape and v0.26.1
  scheduled it; it is not. `NodeSDK`, `OTLPTraceExporter` and `getNodeAutoInstrumentations` in
  `packages/core/src/telemetry-setup.ts` compile and pass unchanged against 0.222.0 / 0.80.0, as do
  `resourceFromAttributes`, `ReadableSpan` and `JsonTraceSerializer` in
  `packages/telemetry/src/exporters/otlp.ts`. No public-API change.

  - `@tuttiai/discord`: `discord.js` `14.26.3` → `14.27.0`, clearing the `undici` HTTP header
    injection via `Set-Cookie` percent-decoding.
  - `@tuttiai/email`: `nodemailer` `8.0.7` → `10.0.1`, clearing CRLF injection in `List-*` header
    comments, which allows arbitrary header injection and which this voice is exposed to because it
    passes caller-supplied headers straight through. Also `mailparser` `3.9.8` → `3.9.23`, clearing
    the quadratic-complexity scan loop in `linkify-it`, and `imapflow` `1.3.3` → `1.7.8`.

  `nodemailer` crosses two majors. The voice's surface on it is one call —
  `createTransport({ host, port, secure, auth })` in `voices/email/src/smtp.ts`, cast through
  `unknown` to the local `SmtpTransporterLike` interface — and that options shape is unchanged
  across 9 and 10. Typecheck, build and the 53 email tests pass. Those tests drive an injected
  factory rather than a live SMTP server, so they prove the integration compiles and behaves, not
  that a real send against a v10 transport was exercised.

  Also bumped, and deliberately not versioned because they do not reach a published artefact:
  `vitest` and `@vitest/coverage-v8` `3.2.4` → `3.2.7` at the root and in `@tuttiai/deploy`,
  `@tuttiai/realtime` and `@tuttiai/router`, clearing both criticals
  ([GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp), arbitrary file read and
  execution while the Vitest UI server is listening).
