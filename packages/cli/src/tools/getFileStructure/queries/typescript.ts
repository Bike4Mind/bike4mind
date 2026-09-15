import type { LanguageQueries } from '../types';

/**
 * Tree-sitter S-expression queries for TypeScript/JavaScript/TSX.
 *
 * These queries extract structural elements from the AST. Each query uses
 * @capture names that the engine maps to StructureItem fields.
 *
 * Works for: .ts, .tsx, .js, .jsx, .mjs, .cjs
 */
export const typescriptQueries: LanguageQueries = {
  imports: `
    (import_statement
      source: (string) @source
    ) @import
  `,

  exports: `
    (export_statement
      declaration: (function_declaration
        name: (identifier) @name)
    ) @export

    (export_statement
      declaration: (class_declaration
        name: (type_identifier) @name)
    ) @export

    (export_statement
      declaration: (interface_declaration
        name: (type_identifier) @name)
    ) @export

    (export_statement
      declaration: (type_alias_declaration
        name: (type_identifier) @name)
    ) @export

    (export_statement
      declaration: (enum_declaration
        name: (identifier) @name)
    ) @export

    (export_statement
      declaration: (lexical_declaration
        (variable_declarator
          name: (identifier) @name))
    ) @export

    (export_statement
      (export_clause
        (export_specifier
          name: (identifier) @name))
    ) @export
  `,

  functions: `
    (function_declaration
      name: (identifier) @name
    ) @function

    (lexical_declaration
      (variable_declarator
        name: (identifier) @name
        value: (arrow_function)
      )
    ) @function
  `,

  classes: `
    (class_declaration
      name: (type_identifier) @name
    ) @class
  `,

  interfaces: `
    (interface_declaration
      name: (type_identifier) @name
    ) @interface
  `,

  types: `
    (type_alias_declaration
      name: (type_identifier) @name
    ) @type

    (enum_declaration
      name: (identifier) @name
    ) @enum
  `,
};
