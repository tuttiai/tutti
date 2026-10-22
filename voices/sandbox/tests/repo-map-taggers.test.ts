import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { isIgnoredPath, languageFor, looksBinary } from "../src/repo-map/languages.js";
import { tagWithRegex } from "../src/repo-map/regex-tagger.js";
import { tagSource } from "../src/repo-map/tagger.js";
import { grammarFor } from "../src/repo-map/tree-sitter.js";
import { MAX_SIGNATURE_CHARS, toSignature } from "../src/repo-map/types.js";
import type { FileTags, LanguageId } from "../src/repo-map/types.js";
import { languageSample } from "./fixtures/repo-map/index.js";

function sample(file: string): string {
  return readFileSync(languageSample(file), "utf-8");
}

function defs(tags: FileTags): string[] {
  return tags.definitions.map((d) => `${d.kind} ${d.name} @${d.line}`);
}

function refs(tags: FileTags): Map<string, number> {
  return new Map(tags.references);
}

async function tag(language: LanguageId, file: string): Promise<FileTags> {
  return tagSource(language, sample(file));
}

describe("tree-sitter tagger", () => {
  it("reads TypeScript definitions of every kind", async () => {
    const tags = await tag("typescript", "sample.ts");
    expect(tags.tagger).toBe("tree-sitter");
    expect(defs(tags)).toEqual([
      "interface Shape @1", "type ShapeId @5", "enum Colour @7", "class BaseShape @11",
      "method area @12", "class Square @15", "method area @16", "function computeArea @21",
      "function makeSquare @25", "constant DEFAULT_SIDE @27", "module Geometry @29",
    ]);
    expect(tags.definitions[0]?.signature).toBe("export interface Shape {");
  });

  it("counts identifier uses but not the definition's own name", async () => {
    const tags = await tag("typescript", "sample.ts");
    expect(refs(tags).get("computeArea")).toBe(1);
    expect(refs(tags).get("Square")).toBe(2);
  });

  it("reads TSX", async () => {
    expect(defs(await tag("tsx", "sample.tsx"))).toEqual([
      "function GreetingCard @1", "function formatGreeting @5",
    ]);
  });

  it("reads JavaScript", async () => {
    expect(defs(await tag("javascript", "sample.js"))).toEqual([
      "class EventBus @1", "method emit @2", "function dispatchEvent @7", "function createBus @11",
    ]);
  });

  it("reads Python", async () => {
    expect(defs(await tag("python", "sample.py"))).toEqual([
      "class Repository @1", "function find_user @2", "function load_record @6",
    ]);
  });

  it("reads Go, preferring struct and interface over type", async () => {
    expect(defs(await tag("go", "sample.go"))).toEqual([
      "struct Store @3", "interface Reader @7", "type Label @11",
      "function NewStore @13", "method Read @17",
    ]);
  });

  it("reads PHP", async () => {
    expect(defs(await tag("php", "sample.php"))).toEqual([
      "interface Notifier @3", "trait Loggable @5", "enum Status @7",
      "class Mailer @11", "method send @12", "function format_address @17",
    ]);
  });

  it("has no grammar for Swift or Kotlin", async () => {
    expect(await grammarFor("swift")).toBeUndefined();
    expect(await grammarFor("kotlin")).toBeUndefined();
  });
});

describe("regex tagger", () => {
  it("reads Swift definitions and skips extensions", async () => {
    const tags = await tag("swift", "sample.swift");
    expect(tags.tagger).toBe("regex");
    expect(defs(tags)).toEqual([
      "protocol Drawable @3", "function draw @4", "class Canvas @8", "function draw @9",
      "function shared @13", "struct Point @18", "enum Direction @22", "class Counter @26",
      "type Handler @28", "function renderScene @30",
    ]);
  });

  it("reads Kotlin definitions, including extension functions", async () => {
    expect(defs(await tag("kotlin", "sample.kt"))).toEqual([
      "interface Repository @3", "function findAll @4", "class User @7", "class Result @9",
      "class Registry @11", "class Colour @13", "type Names @15", "class UserRepository @17",
      "function findAll @18", "function loadNames @21", "function secondOrNull @23",
    ]);
  });

  it("counts identifier uses, leaving out keywords and the definition itself", () => {
    const tags = tagWithRegex("swift", sample("sample.swift"));
    expect(refs(tags).get("renderScene")).toBe(1);
    expect(refs(tags).has("func")).toBe(false);
  });

  it("falls back to generic rules for other languages", () => {
    const tags = tagWithRegex("python", sample("sample.py"));
    expect(defs(tags)).toEqual([
      "class Repository @1", "function find_user @2", "function load_record @6",
    ]);
  });
});

describe("languages", () => {
  it("maps extensions to languages", () => {
    expect(languageFor("a/b.MTS")).toBe("typescript");
    expect(languageFor("x.kts")).toBe("kotlin");
    expect(languageFor("README.md")).toBeUndefined();
  });

  it("ignores dependency, build and generated paths", () => {
    expect(isIgnoredPath("node_modules/a/index.js")).toBe(true);
    expect(isIgnoredPath("packages/x/dist/index.js")).toBe(true);
    expect(isIgnoredPath("src/app.min.js")).toBe(true);
    expect(isIgnoredPath("api/service.pb.go")).toBe(true);
    expect(isIgnoredPath("package-lock.json")).toBe(true);
    expect(isIgnoredPath("src/dist.ts")).toBe(false);
  });

  it("detects binary content by a NUL byte", () => {
    expect(looksBinary(Buffer.from("text\0"))).toBe(true);
    expect(looksBinary(Buffer.from("text"))).toBe(false);
  });

  it("caps signatures", () => {
    const sig = toSignature("  " + "x".repeat(500));
    expect(sig.length).toBe(MAX_SIGNATURE_CHARS);
    expect(sig.endsWith("…")).toBe(true);
  });
});
