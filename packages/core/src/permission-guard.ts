import type { Permission, Voice } from "@tuttiai/types";
import { logger } from "./logger.js";
import { PermissionError } from "./errors.js";

export class PermissionGuard {
  static check(voice: Voice, granted: Permission[]): void {
    const missing = voice.required_permissions.filter(
      (p) => !granted.includes(p),
    );
    if (missing.length > 0) {
      throw new PermissionError(voice.name, voice.required_permissions, granted);
    }
  }

  static warn(voice: Voice): void {
    const dangerous = voice.required_permissions.filter(
      (p) => p === "shell" || p === "filesystem",
    );
    if (dangerous.length > 0) {
      logger.warn(
        { voice: voice.name, permissions: dangerous },
        "Voice has elevated permissions",
      );
    }
  }
}
