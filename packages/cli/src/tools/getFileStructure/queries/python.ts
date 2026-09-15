import type { LanguageQueries } from '../types';

/**
 * Tree-sitter S-expression queries for Python.
 *
 * Python doesn't have language-level exports or interfaces,
 * so those queries are empty strings.
 */
export const pythonQueries: LanguageQueries = {
  imports: `
    (import_statement
      name: (dotted_name) @source
    ) @import

    (import_from_statement
      module_name: (dotted_name) @source
    ) @import_from
  `,

  // Python uses __all__ convention, not language-level exports
  exports: '',

  functions: `
    (function_definition
      name: (identifier) @name
    ) @function
  `,

  classes: `
    (class_definition
      name: (identifier) @name
    ) @class
  `,

  // Python has no interface keyword (Protocol is a runtime construct)
  interfaces: '',

  // Python has no type alias syntax at the grammar level
  types: '',
};
