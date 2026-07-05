import type { LanguageQueries } from '../types';
import { typescriptQueries } from './typescript';
import { javascriptQueries } from './javascript';
import { pythonQueries } from './python';

/** Registry mapping tree-sitter language identifiers to their query definitions. */
export const LANGUAGE_QUERIES: Record<string, LanguageQueries> = {
  typescript: typescriptQueries,
  tsx: typescriptQueries,
  javascript: javascriptQueries,
  python: pythonQueries,
};
