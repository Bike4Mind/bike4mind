/**
 * Tree-sitter S-expression queries for each structural category.
 * Empty strings indicate the language doesn't have that concept.
 */
export interface LanguageQueries {
  imports: string;
  exports: string;
  functions: string;
  classes: string;
  interfaces: string;
  types: string;
}

/** A single structural element extracted from a source file. */
export interface StructureItem {
  kind: 'import' | 'export' | 'function' | 'class' | 'interface' | 'type' | 'enum';
  name: string;
  line: number;
  exported?: boolean;
  details?: string;
}

/**
 * Map file extensions to tree-sitter language identifiers.
 * Language IDs must match WASM file names (e.g. 'typescript' -> tree-sitter-typescript.wasm).
 */
export const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
};
