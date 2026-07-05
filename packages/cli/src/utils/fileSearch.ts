import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncFzf, type FzfResultItem } from 'fzf';
import { fdir } from 'fdir';
import ignore from 'ignore';

export interface FileSearchResult {
  path: string; // Relative path from cwd
  isDirectory: boolean;
  size?: number; // File size in bytes (only for files)
}

/**
 * Load gitignore rules from project root
 */
function loadIgnoreRules(projectRoot: string): ReturnType<typeof ignore> {
  const ig = ignore();

  // Always ignore .git
  ig.add('.git/');

  // Try to load .gitignore
  const gitignorePath = path.join(projectRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    try {
      const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
      ig.add(gitignoreContent);
    } catch {
      // Ignore errors reading .gitignore
    }
  }

  return ig;
}

/**
 * Crawl directory and collect files/directories
 * @param projectRoot - The project root directory
 * @param maxDepth - Maximum depth to traverse
 * @param maxFiles - Maximum number of files to collect
 * @param ig - Ignore instance with gitignore rules
 * @returns Array of relative paths
 */
function crawlDirectory(
  projectRoot: string,
  maxDepth: number = 10,
  maxFiles: number = 20000,
  ig: ReturnType<typeof ignore>
): string[] {
  let fileCount = 0;

  const crawler = new fdir()
    .withRelativePaths()
    .withDirs()
    .withPathSeparator('/')
    .exclude((dirPath: string) => {
      // Convert absolute path to relative with trailing slash
      const relativePath = path.posix.relative(projectRoot, dirPath);

      // Skip root directory check (empty or ".")
      if (!relativePath || relativePath === '.') {
        return false;
      }

      const pathWithSlash = `${relativePath}/`;
      return ig.ignores(pathWithSlash);
    })
    .filter(() => {
      if (fileCount >= maxFiles) {
        return false;
      }
      fileCount++;
      return true;
    });

  if (maxDepth !== undefined) {
    crawler.withMaxDepth(maxDepth);
  }

  const paths = crawler.crawl(projectRoot).sync() as string[];

  // Filter out ignored files (directories are already filtered during crawl)
  return paths.filter(p => {
    // Skip empty or "." paths
    if (!p || p === '.') {
      return true;
    }
    return !ig.ignores(p);
  });
}

/**
 * Walk a directory recursively and collect files/directories with metadata
 * @param basePath - The base directory to walk (defaults to cwd)
 * @param maxDepth - Maximum depth to traverse (default: 10)
 * @returns Array of FileSearchResult
 */
export function walkDirectory(basePath: string = process.cwd(), maxDepth: number = 10): FileSearchResult[] {
  const normalizedBase = path.resolve(basePath);
  const ig = loadIgnoreRules(normalizedBase);

  const paths = crawlDirectory(normalizedBase, maxDepth, 20000, ig);

  const results: FileSearchResult[] = [];

  for (const relativePath of paths) {
    const fullPath = path.join(normalizedBase, relativePath);

    try {
      const stats = fs.statSync(fullPath);

      results.push({
        path: relativePath,
        isDirectory: stats.isDirectory(),
        size: stats.isFile() ? stats.size : undefined,
      });
    } catch {
      // Skip files we can't stat
      results.push({
        path: relativePath,
        isDirectory: false,
      });
    }
  }

  return results;
}

/**
 * Format file size to human readable format
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Cache for file search results
let cachedFiles: string[] | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL_MS = 30000; // 30 seconds cache

/**
 * Get cached file list or refresh if stale
 */
function getCachedFiles(projectRoot: string = process.cwd()): string[] {
  const now = Date.now();
  if (!cachedFiles || now - cacheTimestamp > CACHE_TTL_MS) {
    const normalizedBase = path.resolve(projectRoot);
    const ig = loadIgnoreRules(normalizedBase);
    cachedFiles = crawlDirectory(normalizedBase, 10, 20000, ig);
    cacheTimestamp = now;
  }
  return cachedFiles;
}

/**
 * Invalidate the file cache (call when files may have changed)
 */
export function invalidateFileCache(): void {
  cachedFiles = null;
  cacheTimestamp = 0;
}

/**
 * Warm up the file cache in the background
 * Call this early (e.g., when InputPrompt mounts) to prevent lag on first @ usage
 */
export function warmFileCache(): void {
  // Asynchronously populate cache if not already cached
  if (!cachedFiles || Date.now() - cacheTimestamp > CACHE_TTL_MS) {
    // Use setImmediate to not block the current event loop
    setImmediate(() => {
      getCachedFiles();
    });
  }
}

/**
 * List files in an absolute directory path with optional filtering
 * @param absolutePath - Absolute directory path
 * @param filterQuery - Optional query to filter results (case-insensitive prefix/contains match)
 * @returns Array of files/directories in that path (max 15)
 */
function listAbsoluteDirectory(absolutePath: string, filterQuery?: string): FileSearchResult[] {
  try {
    // Normalize the path
    const normalizedPath = path.normalize(absolutePath);

    // Check if path exists
    if (!fs.existsSync(normalizedPath)) {
      return [];
    }

    // Check if it's a directory
    const stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      return [];
    }

    // Read directory contents
    const entries = fs.readdirSync(normalizedPath, { withFileTypes: true });

    // Filter entries if query is provided
    let filteredEntries = entries;
    if (filterQuery && filterQuery.length > 0) {
      const lowerQuery = filterQuery.toLowerCase();
      filteredEntries = entries.filter(entry => entry.name.toLowerCase().includes(lowerQuery));
    }

    // Convert to FileSearchResult format (max 15 items)
    return filteredEntries.slice(0, 15).map(entry => {
      const fullPath = path.join(normalizedPath, entry.name);
      const result: FileSearchResult = {
        path: fullPath,
        isDirectory: entry.isDirectory(),
      };

      // Add file size if it's a file
      if (entry.isFile()) {
        try {
          const fileStats = fs.statSync(fullPath);
          result.size = fileStats.size;
        } catch {
          // Ignore stat errors
        }
      }

      return result;
    });
  } catch {
    // If any error occurs (permission denied, etc.), return empty
    return [];
  }
}

/**
 * Search files using fzf fuzzy matching
 * @param query - The search query (path or partial path)
 * @param maxResults - Maximum number of results to return (default: 20)
 * @returns Array of matching files, sorted by relevance
 */
export async function searchFiles(query: string, maxResults: number = 20): Promise<FileSearchResult[]> {
  const projectRoot = process.cwd();

  // Handle absolute paths by listing directory contents
  if (path.isAbsolute(query)) {
    // First, check if the path itself is a directory
    try {
      const stats = fs.statSync(query);
      if (stats.isDirectory()) {
        return listAbsoluteDirectory(query);
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }

    // Path doesn't exist or is not a directory - user is typing
    let dirToList: string;
    let filterQuery: string | undefined;

    if (query.endsWith('/') || query.endsWith(path.sep)) {
      dirToList = query;
      filterQuery = undefined;
    } else {
      dirToList = path.dirname(query);
      filterQuery = path.basename(query);
    }

    return listAbsoluteDirectory(dirToList, filterQuery);
  }

  const files = getCachedFiles(projectRoot);

  // If query is empty, return root level items only
  if (!query || query.trim() === '') {
    const rootFiles = files.filter(f => !f.includes('/')).slice(0, maxResults);
    return rootFiles.map(p => {
      const fullPath = path.join(projectRoot, p);
      try {
        const stats = fs.statSync(fullPath);
        return {
          path: p,
          isDirectory: stats.isDirectory(),
          size: stats.isFile() ? stats.size : undefined,
        };
      } catch {
        return { path: p, isDirectory: false };
      }
    });
  }

  // Use fzf for fuzzy matching
  const fzf = new AsyncFzf(files);
  const results = await fzf.find(query);

  // Take top results and add metadata
  return results.slice(0, maxResults).map((result: FzfResultItem<string>) => {
    const p = result.item;
    const fullPath = path.join(projectRoot, p);
    try {
      const stats = fs.statSync(fullPath);
      return {
        path: p,
        isDirectory: stats.isDirectory(),
        size: stats.isFile() ? stats.size : undefined,
      };
    } catch {
      return { path: p, isDirectory: false };
    }
  });
}

/**
 * Check if a path is safely within the current working directory
 * @param filePath - The path to validate
 * @returns true if the path is within cwd, false otherwise
 */
export function isPathWithinCwd(filePath: string): boolean {
  const cwd = path.resolve(process.cwd());
  const absolutePath = path.resolve(cwd, filePath);

  // Try to resolve symlinks if the path exists
  let resolvedCwd = cwd;
  let resolvedPath = absolutePath;

  try {
    const realCwd = fs.realpathSync.native(cwd);
    // Only use the resolved path if it's valid (guards against mocked fs returning undefined)
    if (realCwd) {
      resolvedCwd = realCwd;
    }
  } catch {
    // cwd should always exist, but fall back to original if not
  }

  try {
    const realPath = fs.realpathSync.native(absolutePath);
    // Only use the resolved path if it's valid (guards against mocked fs returning undefined)
    if (realPath) {
      resolvedPath = realPath;
    }
  } catch {
    // Path doesn't exist yet - resolve relative to the canonical cwd for the security check
    const relativePath = path.relative(resolvedCwd, absolutePath);
    resolvedPath = path.resolve(resolvedCwd, relativePath);
  }

  // Normalize for case-insensitive filesystems (Windows)
  const normalizedCwd = resolvedCwd.toLowerCase();
  const normalizedPath = resolvedPath.toLowerCase();

  // Check if resolved path is within cwd
  const isWithin = normalizedPath === normalizedCwd || normalizedPath.startsWith(normalizedCwd + path.sep);

  if (!isWithin) {
    return false;
  }

  // Additional check: ensure no path components are '..'
  const relativePath = path.relative(resolvedCwd, resolvedPath);
  return !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

/**
 * Check if a file is likely binary
 * @param filePath - Path to the file
 * @returns true if the file appears to be binary
 */
export function isBinaryFile(filePath: string): boolean {
  const binaryExtensions = [
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.bmp',
    '.ico',
    '.webp',
    // .svg is NOT included: SVG is XML text and can be read safely
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.zip',
    '.tar',
    '.gz',
    '.rar',
    '.7z',
    '.exe',
    '.dll',
    '.so',
    '.dylib',
    '.bin',
    '.dat',
    '.mp3',
    '.mp4',
    '.wav',
    '.avi',
    '.mov',
    '.mkv',
    '.ttf',
    '.otf',
    '.woff',
    '.woff2',
    '.eot',
    '.class',
    '.pyc',
    '.o',
    '.obj',
  ];

  const ext = path.extname(filePath).toLowerCase();
  return binaryExtensions.includes(ext);
}

/**
 * Get the maximum file size allowed for content injection (10MB)
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB in bytes
