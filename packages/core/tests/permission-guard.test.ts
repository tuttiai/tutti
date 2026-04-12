import { describe, it, expect, vi } from "vitest";
import { PermissionGuard } from "../src/permission-guard.js";
import { logger } from "../src/logger.js";
import type { Voice, Permission } from "@tuttiai/types";

function makeVoice(permissions: Permission[]): Voice {
  return {
    name: "test-voice",
    required_permissions: permissions,
    tools: [],
  };
}

describe("PermissionGuard", () => {
  describe("check()", () => {
    it("does not throw when all permissions are granted", () => {
      const voice = makeVoice(["filesystem", "network"]);
      expect(() =>
        PermissionGuard.check(voice, ["filesystem", "network"]),
      ).not.toThrow();
    });

    it("does not throw when granted permissions are a superset", () => {
      const voice = makeVoice(["network"]);
      expect(() =>
        PermissionGuard.check(voice, ["network", "filesystem", "shell"]),
      ).not.toThrow();
    });

    it("does not throw for a voice with no required permissions", () => {
      const voice = makeVoice([]);
      expect(() => PermissionGuard.check(voice, [])).not.toThrow();
    });

    it("throws when a required permission is missing", () => {
      const voice = makeVoice(["filesystem"]);
      expect(() => PermissionGuard.check(voice, [])).toThrow(
        "Voice test-voice requires permissions not granted: filesystem",
      );
    });

    it("throws listing all missing permissions", () => {
      const voice = makeVoice(["filesystem", "shell"]);
      expect(() => PermissionGuard.check(voice, ["network"])).toThrow(
        "Voice test-voice requires permissions not granted: filesystem, shell",
      );
    });

    it("includes grant instructions in the error message", () => {
      const voice = makeVoice(["browser"]);
      expect(() => PermissionGuard.check(voice, [])).toThrow(
        "permissions: ['browser']",
      );
    });
  });

  describe("warn()", () => {
    it("logs a warning for shell permission", () => {
      const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const voice = makeVoice(["shell"]);

      PermissionGuard.warn(voice);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ voice: "test-voice", permissions: ["shell"] }),
        "Voice has elevated permissions",
      );
      spy.mockRestore();
    });

    it("logs a warning for filesystem permission", () => {
      const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const voice = makeVoice(["filesystem"]);

      PermissionGuard.warn(voice);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({ voice: "test-voice", permissions: ["filesystem"] }),
        "Voice has elevated permissions",
      );
      spy.mockRestore();
    });

    it("does not warn for network or browser permissions", () => {
      const spy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const voice = makeVoice(["network", "browser"]);

      PermissionGuard.warn(voice);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
