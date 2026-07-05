import { createRequire } from 'module';
import { readFileSync } from 'fs';
import type { StructureItem, LanguageQueries } from './types';
import { EXTENSION_TO_LANGUAGE } from './types';
import { LANGUAGE_QUERIES } from './queries/index';

const require = createRequire(import.meta.url);

/**
 * Minimal type definitions for web-tree-sitter to avoid compile-time dependency.
 * The actual package is only installed in @bike4mind/cli, loaded dynamically at runtime.
 */
interface TSPoint {
  row: number;
  column: number;
}

interface TSNode {
  text: string;
  startPosition: TSPoint;
}

interface TSQueryCapture {
  name: string;
  node: TSNode;
}

interface TSQueryMatch {
  captures: TSQueryCapture[];
}

interface TSQuery {
  matches(node: TSNode): TSQueryMatch[];
  delete(): void;
}

interface TSTree {
  rootNode: TSNode;
  delete(): void;
}

interface TSLanguage {
  // opaque type
}

interface TSParser {
  setLanguage(language: TSLanguage): void;
  parse(source: string): TSTree | null;
  delete(): void;
}

interface TSParserConstructor {
  new (): TSParser;
  init(options: Record<string, unknown>): Promise<void>;
}

interface TSModule {
  Parser: TSParserConstructor;
  Language: {
    load(path: string): Promise<TSLanguage>;
  };
  Query: new (language: TSLanguage, source: string) => TSQuery;
}

// Lazy-loaded module reference
let TreeSitter: TSModule;
let parserInitialized = false;

// Cache loaded languages to avoid re-loading WASM per call
const languageCache = new Map<string, TSLanguage>();

function locateTreeSitterWasm(): string {
  return require.resolve('web-tree-sitter/tree-sitter.wasm');
}

function locateLanguageWasm(language: string): string {
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`);
}

/** Initialize the tree-sitter parser (lazy, one-time). */
async function ensureInitialized(): Promise<void> {
  if (parserInitialized) return;

  try {
    // Use variable to prevent TypeScript from resolving module at compile time
    const moduleName = 'web-tree-sitter';
    TreeSitter = (await import(/* webpackIgnore: true */ moduleName)) as unknown as TSModule;
  } catch {
    throw new Error(
      'web-tree-sitter is not available. Install it with: pnpm add web-tree-sitter tree-sitter-wasms --filter @bike4mind/cli'
    );
  }

  const wasmPath = locateTreeSitterWasm();
  const wasmBinary = readFileSync(wasmPath);

  await TreeSitter.Parser.init({
    locateFile: (scriptName: string) => {
      if (scriptName === 'tree-sitter.wasm') {
        return wasmPath;
      }
      return scriptName;
    },
    wasmBinary,
  });

  parserInitialized = true;
}

/** Load and cache a language grammar. */
async function loadLanguage(languageId: string): Promise<TSLanguage> {
  const cached = languageCache.get(languageId);
  if (cached) return cached;

  const wasmPath = locateLanguageWasm(languageId);
  const language = await TreeSitter.Language.load(wasmPath);
  languageCache.set(languageId, language);
  return language;
}

/** Run a single query category and extract structure items. */
function runQuery(
  language: TSLanguage,
  rootNode: TSNode,
  querySource: string,
  kind: StructureItem['kind']
): StructureItem[] {
  if (!querySource.trim()) return [];

  const items: StructureItem[] = [];
  const query = new TreeSitter.Query(language, querySource);

  try {
    const matches = query.matches(rootNode);

    for (const match of matches) {
      const nameCapture = match.captures.find(c => c.name === 'name');
      const sourceCapture = match.captures.find(c => c.name === 'source');

      if (kind === 'import') {
        const importCapture = match.captures.find(c => c.name === 'import' || c.name === 'import_from');
        const node = importCapture?.node || sourceCapture?.node;
        if (node) {
          items.push({
            kind: 'import',
            name: sourceCapture?.node.text.replace(/['"]/g, '') || '',
            line: node.startPosition.row + 1,
            details: node.text,
          });
        }
      } else if (nameCapture) {
        items.push({
          kind,
          name: nameCapture.node.text,
          line: nameCapture.node.startPosition.row + 1,
          ...(kind === 'export' && { exported: true }),
        });
      }
    }
  } finally {
    query.delete();
  }

  return items;
}

/** Query category keys mapped to their StructureItem kind (singular of plural). */
const QUERY_CATEGORIES: Array<[keyof LanguageQueries, StructureItem['kind']]> = [
  ['imports', 'import'],
  ['exports', 'export'],
  ['functions', 'function'],
  ['classes', 'class'],
  ['interfaces', 'interface'],
  ['types', 'type'],
];

/**
 * Parse a source file and extract its structural elements.
 */
export async function parseFileStructure(sourceCode: string, languageId: string): Promise<StructureItem[]> {
  await ensureInitialized();

  const queries = LANGUAGE_QUERIES[languageId];
  if (!queries) {
    throw new Error(
      `No query definitions for language: ${languageId}. Supported: ${getSupportedLanguages().join(', ')}`
    );
  }

  const language = await loadLanguage(languageId);
  const parser = new TreeSitter.Parser();
  let tree: TSTree | null = null;

  try {
    parser.setLanguage(language);
    tree = parser.parse(sourceCode);
    if (!tree) {
      throw new Error('Failed to parse source code');
    }

    const allItems: StructureItem[] = [];
    for (const [queryKey, kind] of QUERY_CATEGORIES) {
      allItems.push(...runQuery(language, tree.rootNode, queries[queryKey], kind));
    }

    return deduplicateItems(allItems);
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/**
 * Deduplicate structure items. When an item appears as both an export and a
 * function/class/type, mark the definition as exported and drop the separate export entry.
 */
function deduplicateItems(items: StructureItem[]): StructureItem[] {
  const exportNames = new Set<string>();
  const definitionNames = new Set<string>();

  for (const item of items) {
    if (item.kind === 'export') {
      exportNames.add(item.name);
    } else if (item.kind !== 'import') {
      definitionNames.add(item.name);
    }
  }

  const result: StructureItem[] = [];
  for (const item of items) {
    // Skip export entries that have a corresponding definition
    if (item.kind === 'export' && definitionNames.has(item.name)) continue;

    // Mark definitions that are exported
    if (item.kind !== 'export' && item.kind !== 'import' && exportNames.has(item.name)) {
      item.exported = true;
    }

    result.push(item);
  }

  return result;
}

export function getSupportedLanguages(): string[] {
  return Object.keys(LANGUAGE_QUERIES);
}

export function getLanguageForExtension(ext: string): string | null {
  return EXTENSION_TO_LANGUAGE[ext] || null;
}
