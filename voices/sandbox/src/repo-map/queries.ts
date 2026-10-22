/**
 * Tree-sitter queries for definitions, one set per grammar.
 *
 * Each pattern captures the definition's name as `@name` and the whole
 * definition as `@definition.<kind>`, the convention of tree-sitter's own
 * `tags.scm` files. They are written here rather than copied, and kept to
 * what a map needs: things an agent would look up by name.
 */

import type { LanguageId } from "./types.js";

const JS_COMMON = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name
  value: [(arrow_function) (function_expression)])) @definition.function
(variable_declaration (variable_declarator name: (identifier) @name
  value: [(arrow_function) (function_expression)])) @definition.function
(export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @definition.constant
`;

const TYPESCRIPT = `${JS_COMMON}
(class_declaration name: (type_identifier) @name) @definition.class
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(abstract_method_signature name: (property_identifier) @name) @definition.method
(internal_module name: (identifier) @name) @definition.module
`;

const JAVASCRIPT = `${JS_COMMON}
(class_declaration name: (identifier) @name) @definition.class
`;

const PYTHON = `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
`;

const GO = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.struct
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(type_spec name: (type_identifier) @name) @definition.type
`;

const PHP = `
(function_definition name: (name) @name) @definition.function
(class_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(trait_declaration name: (name) @name) @definition.trait
(enum_declaration name: (name) @name) @definition.enum
(method_declaration name: (name) @name) @definition.method
`;

/**
 * Grammar file and definition query for each language tree-sitter reads.
 * Swift and Kotlin are absent: they are read by the regex tagger.
 */
export const TREE_SITTER_LANGUAGES: ReadonlyMap<LanguageId, { wasm: string; query: string }> =
  new Map([
    ["typescript", { wasm: "tree-sitter-typescript.wasm", query: TYPESCRIPT }],
    ["tsx", { wasm: "tree-sitter-tsx.wasm", query: TYPESCRIPT }],
    ["javascript", { wasm: "tree-sitter-javascript.wasm", query: JAVASCRIPT }],
    ["python", { wasm: "tree-sitter-python.wasm", query: PYTHON }],
    ["go", { wasm: "tree-sitter-go.wasm", query: GO }],
    ["php", { wasm: "tree-sitter-php.wasm", query: PHP }],
  ]);

/** Node types whose text is an identifier use, across the grammars above. */
export const IDENTIFIER_NODE_TYPES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "field_identifier",
  "package_identifier",
  "name",
]);
