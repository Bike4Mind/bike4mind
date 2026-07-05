import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** Cached ripgrep binary path after first resolution */
let cachedRgPath: string | null = null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FindDefinitionParams {
  symbol_name: string;
  kind?: string;
  search_path?: string;
}

interface DefinitionMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

interface RipgrepJsonMatch {
  type: 'match';
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

// ---------------------------------------------------------------------------
// Universal keyword map - covers all languages without per-language branching
// ---------------------------------------------------------------------------

const VALID_KINDS = ['class', 'function', 'type', 'interface', 'variable', 'enum', 'struct', 'module'] as const;
type DefinitionKind = (typeof VALID_KINDS)[number];

/**
 * Maps concept-level "kinds" to definition keywords across all languages.
 * The keywords themselves are the language detection - `def` only appears
 * in Python, `func` only in Go, `fn` only in Rust, etc.
 */
const KIND_KEYWORDS: Record<DefinitionKind, string[]> = {
  class: ['class'],
  function: ['function', 'def', 'func', 'fn'],
  type: ['type'],
  interface: ['interface', 'trait', 'protocol'],
  variable: ['const', 'let', 'var'],
  enum: ['enum'],
  struct: ['struct'],
  module: ['module', 'namespace', 'package'],
};

const ALL_KEYWORDS: string[] = Object.values(KIND_KEYWORDS).flat();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve ripgrep binary path via the package's exported `rgPath`.
 * `@vscode/ripgrep` is an optional dependency, so we load it lazily; in 1.18+
 * the binary lives in a platform-specific sibling package and is resolved by
 * the package itself - we just have to ask for it.
 */
async function getRipgrepPath(): Promise<string> {
  if (cachedRgPath) return cachedRgPath;

  let rgPath: string | undefined;
  try {
    ({ rgPath } = await import('@vscode/ripgrep'));
  } catch {
    throw new Error(
      'ripgrep is not available. Install the optional dependency: pnpm add @vscode/ripgrep --filter @bike4mind/cli'
    );
  }

  if (!rgPath || !existsSync(rgPath)) {
    throw new Error(
      `ripgrep binary not found at ${rgPath ?? '<unresolved>'}. ` +
        `Ensure @vscode/ripgrep platform optional dependencies are installed for ${process.platform}-${process.arch}.`
    );
  }

  cachedRgPath = rgPath;
  return rgPath;
}

function isPathWithinWorkspace(targetPath: string, baseCwd: string): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedBase = path.resolve(baseCwd);
  const relativePath = path.relative(resolvedBase, resolvedTarget);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/** Escape special regex characters in the symbol name */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single regex pattern that matches definitions across all languages.
 *
 * Structure:
 *   (export\s+(default\s+)?)?(abstract\s+)?(<keywords>)\s+<symbol>(\b|[=<{(:\s])
 *
 * When `kind` is provided, the keyword alternation is narrowed to just
 * that kind's keywords.
 */
export function buildDefinitionPattern(symbolName: string, kind?: string): string {
  const escaped = escapeRegex(symbolName);

  let keywords: string[];
  if (kind) {
    if (!VALID_KINDS.includes(kind as DefinitionKind)) {
      throw new Error(`Invalid kind "${kind}". Valid kinds: ${VALID_KINDS.join(', ')}`);
    }
    keywords = KIND_KEYWORDS[kind as DefinitionKind];
  } else {
    keywords = ALL_KEYWORDS;
  }

  const keywordGroup = keywords.join('|');

  // Optional export prefix, optional abstract, required keyword + symbol (prefix match via \w*)
  // Prefix match allows "Bedrock" to find "BedrockBackend", "BedrockClaudeStrategy", etc.
  return `(export\\s+(default\\s+)?)?(abstract\\s+)?(${keywordGroup})\\s+${escaped}\\w*`;
}

/**
 * Post-filter to remove false positives from ripgrep matches.
 * Returns true if the line looks like an actual definition.
 */
export function isLikelyDefinition(line: string): boolean {
  const trimmed = line.trim();

  // Comment lines
  if (/^\s*(\/\/|\/\*|\*|#|"""|''')/.test(trimmed)) return false;

  // Import/require lines (but not re-export definitions like `export { X } from`)
  if (/\bimport\s/.test(trimmed) && !/\bexport\b/.test(trimmed)) return false;
  if (/\brequire\s*\(/.test(trimmed) && !/\b(const|let|var)\b/.test(trimmed)) return false;

  // Test mocks
  if (/\b(jest|vi|sinon)\.(mock|stub|spy)\b/.test(trimmed)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Core search
// ---------------------------------------------------------------------------

async function findDefinitions(params: FindDefinitionParams): Promise<string> {
  const { symbol_name, kind, search_path } = params;

  if (!symbol_name || !symbol_name.trim()) {
    throw new Error('symbol_name is required');
  }

  const baseCwd = process.cwd();
  const targetDir = search_path ? path.resolve(baseCwd, search_path) : baseCwd;

  // Security: path traversal guard
  if (!isPathWithinWorkspace(targetDir, baseCwd)) {
    throw new Error(`Path validation failed: "${search_path}" resolves outside the allowed workspace directory`);
  }

  // Validate directory exists
  try {
    const stats = await stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${search_path}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${search_path}`);
    }
    throw error;
  }

  const rgPath = await getRipgrepPath();
  const pattern = buildDefinitionPattern(symbol_name.trim(), kind);

  const rgArgs: string[] = [
    '--json',
    '--max-count',
    '50', // Definitions are rare per file
    '--max-filesize',
    '5M',
    // Case-sensitive - definition names are exact (unlike grep_search)
    pattern,
    targetDir,
  ];

  let stdout: string;
  try {
    const result = await execFileAsync(rgPath, rgArgs, {
      maxBuffer: 10 * 1024 * 1024, // 10MB — definitions produce far less output than grep
    });
    stdout = result.stdout;
  } catch (error: unknown) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    if (execError.code === 1) {
      // ripgrep exit code 1 = no matches
      stdout = execError.stdout || '';
    } else if (execError.code === 2) {
      throw new Error(`Ripgrep error: ${execError.stderr || 'Unknown error'}`);
    } else {
      throw error;
    }
  }

  // Parse JSON output
  const lines = stdout.split('\n').filter(Boolean);
  const allMatches: DefinitionMatch[] = [];

  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.type === 'match') {
        const match = item as RipgrepJsonMatch;
        const lineText = match.data.lines.text.trimEnd();

        if (isLikelyDefinition(lineText)) {
          allMatches.push({
            filePath: path.relative(targetDir, match.data.path.text) || path.basename(match.data.path.text),
            lineNumber: match.data.line_number,
            line: lineText,
          });
        }
      }
    } catch {
      continue;
    }
  }

  if (allMatches.length === 0) {
    const kindInfo = kind ? ` (kind: "${kind}")` : '';
    const pathInfo = search_path ? ` in "${search_path}"` : '';
    return (
      `No definitions found for "${symbol_name}"${kindInfo}${pathInfo}.\n\n` +
      'Suggestions:\n' +
      '- The symbol may be from an external package (node_modules)\n' +
      (kind ? '- Try without the kind filter\n' : '') +
      '- Check for alternate naming (e.g., camelCase vs PascalCase)'
    );
  }

  // Sort: exports first, test files last, then alphabetically by path
  const sorted = allMatches.sort((a, b) => {
    const aIsExport = /\bexport\b/.test(a.line) ? 0 : 1;
    const bIsExport = /\bexport\b/.test(b.line) ? 0 : 1;
    if (aIsExport !== bIsExport) return aIsExport - bIsExport;

    const aIsTest = /(\btest\b|\bspec\b|__tests__|\.test\.|\.spec\.)/.test(a.filePath) ? 1 : 0;
    const bIsTest = /(\btest\b|\bspec\b|__tests__|\.test\.|\.spec\.)/.test(b.filePath) ? 1 : 0;
    if (aIsTest !== bIsTest) return aIsTest - bIsTest;

    return a.filePath.localeCompare(b.filePath);
  });

  // Cap output at 20 results
  const maxResults = 20;
  const displayed = sorted.slice(0, maxResults);
  const truncated = sorted.length > maxResults;

  const count = sorted.length;
  let result = `Found ${count} definition${count === 1 ? '' : 's'} for "${symbol_name}"${truncated ? ` (showing top ${maxResults})` : ''}:\n\n`;

  for (const match of displayed) {
    const trimmed = match.line.trim();
    const displayLine = trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
    result += `${match.filePath}:${match.lineNumber}\n  ${displayLine}\n\n`;
  }

  return result.trim();
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createFindDefinitionTool(): ICompletionOptionTools {
  return {
    toolFn: async (args: unknown) => {
      const params = args as FindDefinitionParams;
      return findDefinitions(params);
    },
    toolSchema: {
      name: 'find_definition',
      description:
        'Find where a class, function, type, or interface is defined in the codebase. ' +
        'Much faster and more precise than grep_search for definition lookups. ' +
        'Works across all languages (TypeScript, JavaScript, Python, Go, Rust, etc.) automatically.',
      parameters: {
        type: 'object',
        properties: {
          symbol_name: {
            type: 'string',
            description:
              'The name (or prefix) of the symbol to find. Supports prefix matching — "Bedrock" finds "BedrockBackend", "BedrockClient", etc.',
          },
          kind: {
            type: 'string',
            description: 'Optional: narrow search to a specific kind of definition',
            enum: ['class', 'function', 'type', 'interface', 'variable', 'enum', 'struct', 'module'],
          },
          search_path: {
            type: 'string',
            description:
              'Optional: directory to search within, relative to current working directory (e.g., "src/auth", "packages/core")',
          },
        },
        required: ['symbol_name'],
      },
    },
  };
}
