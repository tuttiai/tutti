import type { Permission, Voice } from "@tuttiai/types";

export class PermissionGuard {
  static check(voice: Voice, granted: Permission[]): void {
    const missing = voice.required_permissions.filter(
      (p) => !granted.includes(p),
    );
    if (missing.length > 0) {
      throw new Error(
        "Voice " +
          voice.name +
          " requires permissions not granted: " +
          missing.join(", ") +
          "\n\n" +
          "Grant them in your score file:\n" +
          "  permissions: [" +
          missing.map((p) => "'" + p + "'").join(", ") +
          "]",
      );
    }
  }

  static warn(voice: Voice): void {
    const dangerous = voice.required_permissions.filter(
      (p) => p === "shell" || p === "filesystem",
    );
    if (dangerous.length > 0) {
      console.warn(
        "[tutti] Warning: voice " +
          voice.name +
          " has elevated permissions: " +
          dangerous.join(", "),
      );
    }
  }
}
