import type { LanguageQueries } from '../types';

/**
 * Tree-sitter S-expression queries for JavaScript.
 *
 * JavaScript grammar differs from TypeScript: no type_identifier, no interfaces,
 * no type aliases, no enum declarations.
 */
export const javascriptQueries: LanguageQueries = {
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
      name: (identifier) @name
    ) @class
  `,

  // JavaScript has no interface keyword
  interfaces: '',

  // JavaScript has no type aliases or enums
  types: '',
};
