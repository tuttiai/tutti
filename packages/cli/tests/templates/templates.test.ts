import { describe, it, expect } from "vitest";
import { TEMPLATES, getTemplate } from "../../src/templates/index.js";

describe("templates", () => {
  it("has the five project templates", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "minimal",
      "coding-agent",
      "research-agent",
      "qa-pipeline",
      "dev-team",
    ]);
  });

  it.each(TEMPLATES.map((t) => [t.id, t.score] as const))(
    "%s defaults to claude-sonnet-5-5",
    (_id, score) => {
      expect(score).toContain('default_model: "claude-sonnet-5-5"');
      expect(score).not.toContain("claude-sonnet-4-20250514");
    },
  );

  it("returns the template for a known id", () => {
    expect(getTemplate("minimal")?.name).toBe("Minimal");
  });

  it("returns undefined for an unknown id", () => {
    expect(getTemplate("nope")).toBeUndefined();
  });
});
