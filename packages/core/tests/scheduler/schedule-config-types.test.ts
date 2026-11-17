import { describe, it, expectTypeOf } from "vitest";
import type { AgentScheduleConfig } from "@tuttiai/types";
import type { ScheduleConfig } from "../../src/scheduler/types.js";
import { CONFIGS_IN_STEP } from "../../src/scheduler/end-at.js";

// The compile-time guard lives in src/scheduler/end-at.ts so that
// `npm run typecheck` (which covers src only) fails when the two drift.
describe("ScheduleConfig and AgentScheduleConfig", () => {
  it("are the same type, end_at included", () => {
    expectTypeOf<ScheduleConfig>().toEqualTypeOf<AgentScheduleConfig>();
    expectTypeOf<ScheduleConfig["end_at"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf(CONFIGS_IN_STEP).toEqualTypeOf<true>();
  });
});
