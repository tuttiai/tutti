import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import type { TelemetryConfig } from "@tuttiai/types";
import { logger } from "./logger.js";

let sdk: NodeSDK | undefined;

export function initTelemetry(config: TelemetryConfig): void {
  if (!config.enabled || sdk) return;

  const endpoint = config.endpoint ?? "http://localhost:4318";

  const exporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers: config.headers,
  });

  sdk = new NodeSDK({
    traceExporter: exporter,
    instrumentations: [getNodeAutoInstrumentations({ "@opentelemetry/instrumentation-fs": { enabled: false } })],
    serviceName: process.env.OTEL_SERVICE_NAME ?? "tutti",
  });

  sdk.start();

  logger.info({ endpoint }, "OpenTelemetry tracing enabled");
}

export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = undefined;
  }
}
