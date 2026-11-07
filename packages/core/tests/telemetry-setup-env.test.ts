import { afterEach, describe, expect, it, vi } from "vitest";

/** The subset of the NodeSDK configuration these tests read. */
interface CapturedConfig {
  serviceName?: string;
}

const { sdkConfigs } = vi.hoisted(() => {
  const configs: CapturedConfig[] = [];
  return { sdkConfigs: configs };
});

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    constructor(config: CapturedConfig) {
      sdkConfigs.push(config);
    }
    start(): void {
      return undefined;
    }
    async shutdown(): Promise<void> {
      return undefined;
    }
  },
}));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({
  getNodeAutoInstrumentations: (): unknown[] => [],
}));
vi.mock("../src/logger.js", () => ({ logger: { info: vi.fn() } }));

import { initTelemetry, shutdownTelemetry } from "../src/telemetry-setup.js";

function serviceNameFor(value: string | undefined): string | undefined {
  vi.stubEnv("OTEL_SERVICE_NAME", value);
  initTelemetry({ enabled: true });
  return sdkConfigs.at(-1)?.serviceName;
}

describe("initTelemetry OTEL_SERVICE_NAME read", () => {
  afterEach(async () => {
    // The SDK is a module-level singleton: without a shutdown every later
    // call returns early and asserts nothing.
    await shutdownTelemetry();
    vi.unstubAllEnvs();
    sdkConfigs.length = 0;
  });

  it("uses the service name when it is set", () => {
    expect(serviceNameFor("svc-test")).toBe("svc-test");
  });

  it("defaults to tutti when it is unset", () => {
    expect(serviceNameFor(undefined)).toBe("tutti");
  });

  it("passes an empty value through unchanged", () => {
    expect(serviceNameFor("")).toBe("");
  });

  it("reads nothing when telemetry is disabled", () => {
    vi.stubEnv("OTEL_SERVICE_NAME", "svc-test");
    initTelemetry({ enabled: false });
    expect(sdkConfigs).toHaveLength(0);
  });

  it("reads the environment at call time, not at import", async () => {
    expect(serviceNameFor("svc-first")).toBe("svc-first");
    await shutdownTelemetry();
    expect(serviceNameFor("svc-second")).toBe("svc-second");
  });
});
