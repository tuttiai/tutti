import { describe, it, expect, vi } from "vitest";
import { assertDeliveryVoiceInstalled } from "../../src/scheduler/delivery.js";
import type { ScheduleDeliveryTarget } from "@tuttiai/types";

describe("assertDeliveryVoiceInstalled", () => {
  it("resolves when the voice package imports successfully", async () => {
    const importFn = vi.fn().mockResolvedValue({});
    await expect(
      assertDeliveryVoiceInstalled(
        { platform: "slack", channel: "#alerts" },
        importFn,
      ),
    ).resolves.toBeUndefined();
    expect(importFn).toHaveBeenCalledWith("@tuttiai/slack");
  });

  it("throws a remediation error when the voice package is missing", async () => {
    const importFn = vi
      .fn()
      .mockRejectedValue(new Error("Cannot find module '@tuttiai/slack'"));
    await expect(
      assertDeliveryVoiceInstalled(
        { platform: "slack", channel: "#alerts" },
        importFn,
      ),
    ).rejects.toThrow(
      /Scheduled delivery to "slack" requires @tuttiai\/slack\. Run `npm install @tuttiai\/slack`/,
    );
  });

  it("maps each platform to the correct voice package", async () => {
    const cases: Array<[ScheduleDeliveryTarget, string]> = [
      [{ platform: "slack", channel: "#alerts" }, "@tuttiai/slack"],
      [{ platform: "discord", channel_id: "1" }, "@tuttiai/discord"],
      [{ platform: "telegram", chat_id: "1" }, "@tuttiai/telegram"],
      [{ platform: "email", to: "a@b.com" }, "@tuttiai/email"],
      [{ platform: "whatsapp", phone_number: "+15555550123" }, "@tuttiai/whatsapp"],
    ];
    for (const [target, expectedPkg] of cases) {
      const importFn = vi.fn().mockResolvedValue({});
      await assertDeliveryVoiceInstalled(target, importFn);
      expect(importFn).toHaveBeenCalledWith(expectedPkg);
    }
  });
});
