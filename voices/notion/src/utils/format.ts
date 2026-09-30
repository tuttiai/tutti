import { z } from "zod";

import type { Database, Page, PropertyValue } from "../notion-schemas.js";

const RichTextListSchema = z.array(z.object({ plain_text: z.string() }).passthrough());
const NamedSchema = z.object({ name: z.string() }).passthrough();
const NamedListSchema = z.array(NamedSchema);
const DateSchema = z.object({ start: z.string(), end: z.string().nullable().optional() }).passthrough();
const RelationSchema = z.array(z.object({ id: z.string() }).passthrough());
const UniqueIdSchema = z.object({ prefix: z.string().nullable().optional(), number: z.number().nullable() }).passthrough();

/**
 * The plain text of a rich-text array, or an empty string for anything else.
 *
 * @param value - A Notion rich-text array, unvalidated.
 * @returns Its runs joined.
 */
export function plainText(value: unknown): string {
  const parsed = RichTextListSchema.safeParse(value);
  return parsed.success ? parsed.data.map((run) => run.plain_text).join("") : "";
}

/** A property's payload, which Notion keys by the property's own type. */
function payloadOf(property: PropertyValue): unknown {
  return new Map(Object.entries(property)).get(property.type);
}

/** A scalar payload as text; `null` is an unset value. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Readers for the property types whose payload is not a plain scalar. */
const READERS = new Map<string, (payload: unknown) => string>([
  ["title", plainText],
  ["rich_text", plainText],
  ["select", (p) => NamedSchema.safeParse(p).data?.name ?? ""],
  ["status", (p) => NamedSchema.safeParse(p).data?.name ?? ""],
  ["multi_select", (p) => (NamedListSchema.safeParse(p).data ?? []).map((o) => o.name).join(", ")],
  ["people", (p) => (NamedListSchema.safeParse(p).data ?? []).map((o) => o.name).join(", ")],
  ["files", (p) => (NamedListSchema.safeParse(p).data ?? []).map((o) => o.name).join(", ")],
  ["relation", (p) => (RelationSchema.safeParse(p).data ?? []).map((o) => o.id).join(", ")],
  ["date", (p) => dateText(p)],
  ["unique_id", (p) => uniqueIdText(p)],
  ["formula", (p) => innerText(p)],
  ["rollup", (p) => innerText(p)],
]);

/** A date or a date range. */
function dateText(payload: unknown): string {
  const parsed = DateSchema.safeParse(payload);
  if (!parsed.success) return "";
  const { start, end } = parsed.data;
  return end === undefined || end === null ? start : `${start} to ${end}`;
}

/** A unique id such as `TASK-12`. */
function uniqueIdText(payload: unknown): string {
  const parsed = UniqueIdSchema.safeParse(payload);
  if (!parsed.success || parsed.data.number === null) return "";
  const prefix = parsed.data.prefix ?? "";
  return prefix.length > 0 ? `${prefix}-${parsed.data.number}` : String(parsed.data.number);
}

/** A formula or rollup result, which is itself typed. */
function innerText(payload: unknown): string {
  const inner = z.object({ type: z.string() }).passthrough().safeParse(payload);
  return inner.success ? propertyText(inner.data) : "";
}

/**
 * One property value as the text a person would read in Notion.
 *
 * @param property - The property value.
 * @returns Its text, empty when unset, or the type name in brackets for a type this voice does not read.
 */
export function propertyText(property: PropertyValue): string {
  const payload = payloadOf(property);
  const reader = READERS.get(property.type);
  if (reader !== undefined) return reader(payload);
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return `[${property.type}]`;
  return scalarText(payload);
}

/**
 * Every property of a page as `{ name: text }`.
 *
 * @param page - The page.
 * @returns Its properties, read.
 */
export function propertiesText(page: Page): Record<string, string> {
  return Object.fromEntries(Object.entries(page.properties).map(([name, value]) => [name, propertyText(value)]));
}

/**
 * A page's title: the text of whichever property has type `title`.
 *
 * @param page - The page.
 * @returns The title, or `(untitled)`.
 */
export function pageTitle(page: Page): string {
  const title = Object.values(page.properties).find((value) => value.type === "title");
  const text = title === undefined ? "" : propertyText(title);
  return text.length > 0 ? text : "(untitled)";
}

/**
 * A database's title.
 *
 * @param database - The database.
 * @returns The title, or `(untitled)`.
 */
export function databaseTitle(database: Database): string {
  const text = plainText(database.title);
  return text.length > 0 ? text : "(untitled)";
}

/**
 * A page as the list tools report it.
 *
 * @param page - The page.
 * @returns Its id, title, link and properties.
 */
export function pageSummary(page: Page): { id: string; title: string; url: string | undefined; properties: Record<string, string> } {
  return { id: page.id, title: pageTitle(page), url: page.url, properties: propertiesText(page) };
}
