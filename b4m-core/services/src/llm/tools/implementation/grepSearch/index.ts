import { ToolDefinition } from '../../base/types';
import { stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { isPathAllowed } from '../../utils/pathValidation';

const execFileAsync = promisify(execFile);

/** Cached ripgrep binary path after first resolution */
let cachedRgPath: string | null = null;

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
      'ripgrep is not available. Install the optional dependency: pnpm add @vscode/ripgrep --filter @bike4mind/services'
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

interface GrepSearchParams {
  pattern: string;
  dir_path?: string;
  include?: string;
}

interface GrepMatch {
  filePath: string;
  lineNumber: number;
  line: string;
}

interface RipgrepMatch {
  type: string;
  data: {
    path: { text: string };
    line_number: number;
    lines: { text: string };
  };
}

interface RipgrepStats {
  type: string;
  data: {
    stats: {
      searches: number;
      searches_with_match: number;
    };
  };
}

// Path validation is handled by the shared isPathAllowed utility (../../utils/pathValidation).

/**
 * Converts a glob pattern to ripgrep glob patterns
 * Handles common cases like *.ts, *.{ts,tsx}, src/**, etc.
 */
function convertGlobToRipgrepGlobs(globPattern: string): string[] {
  // If no glob pattern, search all files
  if (!globPattern || globPattern === '**/*') {
    return [];
  }

  // Handle patterns like *.{ts,tsx} - split into multiple globs
  const braceMatch = globPattern.match(/\*\.{([^}]+)}/);
  if (braceMatch) {
    const extensions = braceMatch[1].split(',');
    return extensions.map(ext => `*.${ext.trim()}`);
  }

  // Simple pattern like *.ts or src/**/*.ts
  return [globPattern];
}

async function searchFiles(params: GrepSearchParams, allowedDirectories?: string[]): Promise<string> {
  const { pattern, dir_path, include } = params;

  const baseCwd = process.cwd();
  const targetDir = dir_path ? path.resolve(baseCwd, dir_path) : baseCwd;

  // Security: validate path is within allowed directories
  const validation = isPathAllowed(targetDir, allowedDirectories);
  if (!validation.allowed) {
    const dirsMsg =
      allowedDirectories && allowedDirectories.length > 0
        ? `Allowed directories: ${[baseCwd, ...allowedDirectories].join(', ')}`
        : `Working directory: ${baseCwd}`;
    throw new Error(`Path validation failed: "${dir_path}" resolves outside allowed directories. ${dirsMsg}`);
  }

  try {
    const stats = await stat(targetDir);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${dir_path}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Path does not exist: ${dir_path}`);
    }
    throw error;
  }

  // Get ripgrep path (lazy load)
  const rgPath = await getRipgrepPath();

  const rgArgs: string[] = [
    '--json', // Machine-readable output
    '--max-count',
    '500', // Limit matches per file
    '--ignore-case', // Case-insensitive search
    '--max-filesize',
    '10M', // Skip files larger than 10MB
  ];

  const globs = convertGlobToRipgrepGlobs(include || '');
  if (globs.length > 0) {
    globs.forEach(glob => {
      rgArgs.push('--glob', glob);
    });
  }

  rgArgs.push(pattern, targetDir);

  // Execute ripgrep (using execFile to avoid shell injection vulnerabilities)
  let stdout: string;
  try {
    const result = await execFileAsync(rgPath, rgArgs, {
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large results
    });
    stdout = result.stdout;
  } catch (error: unknown) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    // ripgrep exits with code 1 when no matches found
    if (execError.code === 1 && execError.stdout) {
      stdout = execError.stdout;
    } else if (execError.code === 2) {
      // Code 2 indicates an error (check stderr for specific error message)
      const errorMsg = execError.stderr || 'Unknown ripgrep error';
      throw new Error(`Ripgrep error: ${errorMsg}`);
    } else {
      throw error;
    }
  }

  const lines = stdout.split('\n').filter(Boolean);
  const allMatches: GrepMatch[] = [];
  let filesSearched = 0;

  for (const line of lines) {
    try {
      const item = JSON.parse(line);

      if (item.type === 'match') {
        const match = item as RipgrepMatch;
        allMatches.push({
          filePath: path.relative(targetDir, match.data.path.text) || path.basename(match.data.path.text),
          lineNumber: match.data.line_number,
          line: match.data.lines.text.trimEnd(), // Remove trailing newline
        });
      } else if (item.type === 'summary') {
        const stats = item as RipgrepStats;
        filesSearched = stats.data.stats.searches || 0;
      }
    } catch {
      // Skip malformed JSON lines
      continue;
    }
  }

  const searchDirDisplay = dir_path || '.';
  const filterInfo = include ? ` (filter: "${include}")` : '';
  const maxMatches = 500;

  if (allMatches.length === 0) {
    return `No matches found for pattern "${pattern}" in "${searchDirDisplay}"${filterInfo}.\nSearched ${filesSearched} file(s).`;
  }

  // Group matches by file
  const matchesByFile = allMatches.reduce(
    (acc, match) => {
      if (!acc[match.filePath]) {
        acc[match.filePath] = [];
      }
      acc[match.filePath].push(match);
      return acc;
    },
    {} as Record<string, GrepMatch[]>
  );

  const matchCount = allMatches.length;
  const matchTerm = matchCount === 1 ? 'match' : 'matches';
  const truncated = matchCount >= maxMatches;

  let result = `Found ${matchCount} ${matchTerm}${truncated ? ' (truncated)' : ''} for pattern "${pattern}" in "${searchDirDisplay}"${filterInfo}:\n`;
  result += `Searched ${filesSearched} file(s)\n---\n`;

  for (const filePath in matchesByFile) {
    result += `File: ${filePath}\n`;
    matchesByFile[filePath].forEach(match => {
      const trimmedLine = match.line.trim();
      // Truncate very long lines
      const displayLine = trimmedLine.length > 200 ? trimmedLine.slice(0, 200) + '...' : trimmedLine;
      result += `L${match.lineNumber}: ${displayLine}\n`;
    });
    result += '---\n';
  }

  return result.trim();
}

export const grepSearchTool: ToolDefinition = {
  name: 'grep_search',
  implementation: context => ({
    toolFn: async value => {
      const params = value as GrepSearchParams;
      context.logger.info('🔍 GrepSearch: Searching files', {
        pattern: params.pattern,
        dir_path: params.dir_path || '.',
        include: params.include || '**/*',
      });

      try {
        const result = await searchFiles(params, context.allowedDirectories);
        context.logger.info('✅ GrepSearch: Success');
        return result;
      } catch (error) {
        context.logger.error('❌ GrepSearch: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'grep_search',
      description:
        'Searches for a regular expression pattern within the content of files in a specified directory (or current working directory). Can filter files by a glob pattern. Returns the lines containing matches, along with their file paths and line numbers.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              "The regular expression (regex) pattern to search for within file contents (e.g., 'function\\s+myFunction', 'import\\s+\\{.*\\}\\s+from\\s+.*').",
          },
          dir_path: {
            type: 'string',
            description:
              'Optional: The absolute path to the directory to search within. If omitted, searches the current working directory.',
          },
          include: {
            type: 'string',
            description:
              "Optional: A glob pattern to filter which files are searched (e.g., '*.js', '*.{ts,tsx}', 'src/**'). If omitted, searches all files (respecting potential global ignores).",
          },
        },
        required: ['pattern'],
      },
    },
  }),
};
