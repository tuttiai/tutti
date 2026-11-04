import { describe, it, expect } from "vitest";
import { resolvePackageName } from "../../src/commands/add.js";

describe("resolvePackageName", () => {
  it("resolves postgres to the official @tuttiai/postgres voice, not the pg driver", () => {
    expect(resolvePackageName("postgres")).toBe("@tuttiai/postgres");
  });

  it("resolves an unknown bare name to @tuttiai/<name>", () => {
    expect(resolvePackageName("foo")).toBe("@tuttiai/foo");
  });

  it("passes a scoped package name through unchanged", () => {
    expect(resolvePackageName("@acme/voice")).toBe("@acme/voice");
  });
});
