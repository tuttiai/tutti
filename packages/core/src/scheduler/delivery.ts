/**
 * Scheduled-run delivery helpers — voice-presence checks for the
 * platforms a `schedule.deliver` config can target.
 *
 * Tutti voices are optional peer dependencies, so the scheduler can be
 * compiled and exercised without every platform package installed. When
 * a score declares `schedule.deliver`, the engine MUST verify the
 * matching `@tuttiai/<platform>` package resolves before the schedule
 * activates — otherwise the first dispatch attempt would crash deep
 * inside the engine with an opaque module-not-found error.
 *
 * Mirrors the same fail-fast pattern used by `@tuttiai/inbox`'s adapter
 * loaders (see `packages/inbox/src/adapters/slack.ts`).
 */

import type { ScheduleDeliveryTarget } from "@tuttiai/types";

/** Package name that backs each delivery platform. */
const VOICE_PACKAGE: Record<ScheduleDeliveryTarget["platform"], string> = {
  slack: "@tuttiai/slack",
  discord: "@tuttiai/discord",
  telegram: "@tuttiai/telegram",
  email: "@tuttiai/email",
  whatsapp: "@tuttiai/whatsapp",
};

/** Injectable dynamic-import function — tests pass a stub. */
export type DynamicImportFn = (spec: string) => Promise<unknown>;

const defaultImport: DynamicImportFn = (spec) => import(spec);

/**
 * Resolve the `@tuttiai/<platform>` voice for a delivery target, or
 * throw a remediation error when the package is not installed.
 *
 * @param target - The delivery target whose voice we want to verify.
 * @param importFn - Override the dynamic import for tests.
 * @throws When the required voice package fails to resolve. The error
 *   message names the missing package and the install command.
 *
 * @example
 * await assertDeliveryVoiceInstalled({ platform: "slack", channel: "#alerts" });
 */
export async function assertDeliveryVoiceInstalled(
  target: ScheduleDeliveryTarget,
  importFn: DynamicImportFn = defaultImport,
): Promise<void> {
  const pkg = VOICE_PACKAGE[target.platform];
  try {
    await importFn(pkg);
  } catch (err) {
    throw new Error(
      `Scheduled delivery to "${target.platform}" requires ${pkg}. ` +
        `Run \`npm install ${pkg}\` (or \`tutti-ai add ${target.platform}\`) and try again. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
