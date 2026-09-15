import { ToolDefinition } from '../../base/types';
import { glob } from 'glob';
import { stat } from 'fs/promises';
import path from 'path';
import { isPathAllowed } from '../../utils/pathValidation';

interface GlobFilesParams {
  pattern: string;
  dir_path?: string;
  case_sensitive?: boolean;
  respect_git_ignore?: boolean;
}

interface FileResult {
  path: string;
  mtime: number;
}

// Default patterns to ignore for cleaner results
const DEFAULT_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/.turbo/**',
  '**/.sst/**',
  '**/*.min.js',
  '**/*.min.css',
];

async function findFiles(params: GlobFilesParams, allowedDirectories?: string[]): Promise<string> {
  const { pattern, dir_path, case_sensitive = true, respect_git_ignore = true } = params;

  const baseCwd = process.cwd();
  const targetDir = dir_path ? path.resolve(baseCwd, path.normalize(dir_path)) : baseCwd;

  // Security: validate path is within allowed directories
  const validation = isPathAllowed(targetDir, allowedDirectories);
  if (!validation.allowed) {
    const dirsMsg =
      allowedDirectories && allowedDirectories.length > 0
        ? `Allowed directories: ${[baseCwd, ...allowedDirectories].join(', ')}`
        : `Working directory: ${baseCwd}`;
    throw new Error(`Access denied: Cannot search outside allowed directories. ${dirsMsg}`);
  }

  const ignorePatterns = respect_git_ignore ? DEFAULT_IGNORE_PATTERNS : [];

  const matches = await glob(pattern, {
    cwd: targetDir,
    dot: false, // Don't match hidden files by default
    ignore: ignorePatterns,
    absolute: true,
    nodir: true, // Only return files, not directories
    nocase: !case_sensitive, // Case-insensitive if requested
    maxDepth: 20, // Reasonable depth limit
  });

  if (matches.length === 0) {
    return `No files found matching pattern: ${pattern}${dir_path ? ` in ${dir_path}` : ''}`;
  }

  // Stat each match for its modification time (sorted newest-first below).
  const filesWithStats: FileResult[] = [];
  for (const filePath of matches) {
    try {
      const stats = await stat(filePath);
      filesWithStats.push({
        path: filePath,
        mtime: stats.mtimeMs,
      });
    } catch {
      // Skip files that can't be stat'd (permissions, deleted, etc.)
      continue;
    }
  }

  // Sort by modification time (newest first)
  filesWithStats.sort((a, b) => b.mtime - a.mtime);

  // Limit results to prevent overwhelming output
  const MAX_RESULTS = 500;
  const truncated = filesWithStats.length > MAX_RESULTS;
  const results = truncated ? filesWithStats.slice(0, MAX_RESULTS) : filesWithStats;

  const summary = `Found ${filesWithStats.length} file(s)${truncated ? ` (showing first ${MAX_RESULTS})` : ''} matching: ${pattern}`;
  const dirInfo = dir_path ? `\nDirectory: ${dir_path}` : '';

  const filesList = results.map(file => path.relative(baseCwd, file.path)).join('\n');

  return `${summary}${dirInfo}\n\n${filesList}`;
}

export const globFilesTool: ToolDefinition = {
  name: 'glob_files',
  implementation: context => ({
    toolFn: async value => {
      const params = value as GlobFilesParams;
      context.logger.info('🔍 GlobFiles: Finding files', {
        pattern: params.pattern,
        dir_path: params.dir_path || '.',
      });

      try {
        const result = await findFiles(params, context.allowedDirectories);
        context.logger.info('✅ GlobFiles: Success');
        return result;
      } catch (error) {
        context.logger.error('❌ GlobFiles: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'glob_files',
      description:
        'Efficiently finds files matching specific glob patterns (e.g., `src/**/*.ts`, `**/*.md`), returning absolute paths sorted by modification time (newest first). Use this to locate files by name or extension when you need to discover or explore files in a project.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description:
              'The glob pattern to match against file paths. Supports wildcards (*, **), character ranges ([abc]), and brace expansion ({ts,tsx}). Examples: "*.ts" for TypeScript files in current dir, "src/**/*.tsx" for all TSX files in src tree, "**/*.{js,ts}" for all JS/TS files.',
          },
          dir_path: {
            type: 'string',
            description:
              'Optional: The absolute path to the directory to search in. If not specified, uses the current working directory. Must be within the current working directory.',
          },
          case_sensitive: {
            type: 'boolean',
            description:
              'Optional: Whether the pattern matching should be case-sensitive. Defaults to true. Set to false for case-insensitive matching on case-sensitive file systems.',
          },
          respect_git_ignore: {
            type: 'boolean',
            description:
              'Optional: Whether to respect common ignore patterns (node_modules, .git, dist, build, etc.). Defaults to true. Set to false to include all files.',
          },
        },
        required: ['pattern'],
      },
    },
  }),
};
