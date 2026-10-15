import * as fs from 'node:fs';
import * as path from 'node:path';
import { AsyncFzf, type FzfResultItem } from 'fzf';
import { fdir } from 'fdir';
import ignore from 'ignore';
import { isPathWithin } from './pathWithin.js';
import { logger } from './Logger.js';

export interface FileSearchResult {
  path: string; // Relative path from cwd
  isDirectory: boolean;
  size?: number; // File size in bytes (only for files)
}

/**
 * stat() that yields null instead of throwing. Following a symlink is best-effort here:
 * a dangling link, or one pointing somewhere unreadable, must not take down a whole
 * directory listing.
 */
function statOrNull(targetPath: string): fs.Stats | null {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}

/**
 * Never listed, whatever .gitignore says: VCS internals, installed dependencies,
 * and nested worktrees (each one a full copy of the repo, so crawling them
 * multiplies the walk and floods @ results with duplicates).
 */
const ALWAYS_IGNORED = ['.git/', 'node_modules/', '.claude/worktrees/'];

const MAX_CRAWL_DEPTH = 10;
const MAX_CRAWL_ENTRIES = 20000;

/**
 * Load gitignore rules from project root
 */
function loadIgnoreRules(projectRoot: string): ReturnType<typeof ignore> {
  const ig = ignore().add(ALWAYS_IGNORED);

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
 * Crawl a directory and collect files and directories (directories end in '/').
 *
 * Gitignore rules are applied while walking: ignored directories are pruned, and
 * ignored entries never count towards maxEntries, so the cap bounds the listing
 * rather than being spent on entries that get dropped.
 *
 * @returns Paths relative to projectRoot, '/'-separated
 */
async function crawlDirectory(
  projectRoot: string,
  ig: ReturnType<typeof ignore>,
  maxDepth: number = MAX_CRAWL_DEPTH,
  maxEntries: number = MAX_CRAWL_ENTRIES
): Promise<string[]> {
  return (
    new fdir()
      .withRelativePaths()
      .withDirs()
      .withPathSeparator('/')
      .withMaxDepth(maxDepth)
      .withMaxFiles(maxEntries)
      .exclude((_dirName, dirPath) => {
        const relativePath = path.relative(projectRoot, dirPath).split(path.sep).join('/');
        return relativePath !== '' && ig.ignores(`${relativePath}/`);
      })
      // fdir also pushes the root itself as '.', which is not a selectable entry
      // (and 'ignore' throws on it).
      .filter(relativePath => relativePath !== '.' && !ig.ignores(relativePath))
      .crawl(projectRoot)
      .withPromise()
  );
}

/**
 * Walk a directory recursively and collect files/directories with metadata
 * @param basePath - The base directory to walk (defaults to cwd)
 * @param maxDepth - Maximum depth to traverse (default: 10)
 * @param maxEntries - Maximum number of non-ignored entries to collect (default: 20000)
 * @returns Array of FileSearchResult
 */
export async function walkDirectory(
  basePath: string = process.cwd(),
  maxDepth: number = MAX_CRAWL_DEPTH,
  maxEntries: number = MAX_CRAWL_ENTRIES
): Promise<FileSearchResult[]> {
  const normalizedBase = path.resolve(basePath);
  const paths = await crawlDirectory(normalizedBase, loadIgnoreRules(normalizedBase), maxDepth, maxEntries);
  return paths.map(relativePath => describeEntry(normalizedBase, relativePath));
}

/**
 * Stat a crawled entry for its type and size. An entry that vanished since the
 * crawl is still returned, as a file without a size.
 */
function describeEntry(projectRoot: string, relativePath: string): FileSearchResult {
  const stats = statOrNull(path.join(projectRoot, relativePath));
  if (!stats) {
    return { path: relativePath, isDirectory: false };
  }
  return {
    path: relativePath,
    isDirectory: stats.isDirectory(),
    size: stats.isFile() ? stats.size : undefined,
  };
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
type FileCache = { root: string; files: string[]; timestamp: number };
let fileCache: FileCache | null = null;
// One crawl at a time: concurrent callers (the startup warm-up, the first @
// keystrokes) share it instead of each walking the tree.
let inFlightCrawl: { root: string; promise: Promise<string[]> } | null = null;
const CACHE_TTL_MS = 30000; // 30 seconds cache

/**
 * Get cached file list or refresh if stale. The crawl is async, so a large tree
 * never blocks the event loop (and with it, input and rendering).
 */
async function getCachedFiles(projectRoot: string = process.cwd()): Promise<string[]> {
  const root = path.resolve(projectRoot);
  if (fileCache && fileCache.root === root && Date.now() - fileCache.timestamp <= CACHE_TTL_MS) {
    return fileCache.files;
  }
  if (inFlightCrawl?.root === root) {
    return inFlightCrawl.promise;
  }

  const crawl = { root, promise: crawlDirectory(root, loadIgnoreRules(root)) };
  inFlightCrawl = crawl;
  try {
    const files = await crawl.promise;
    // A crawl superseded by invalidateFileCache() must not repopulate the cache.
    if (inFlightCrawl === crawl) {
      fileCache = { root, files, timestamp: Date.now() };
    }
    return files;
  } finally {
    if (inFlightCrawl === crawl) {
      inFlightCrawl = null;
    }
  }
}

/**
 * Invalidate the file cache (call when files may have changed)
 */
export function invalidateFileCache(): void {
  fileCache = null;
  inFlightCrawl = null;
}

/**
 * Warm up the file cache in the background
 * Call this early (e.g., at startup) to prevent lag on first @ usage
 */
export function warmFileCache(): void {
  getCachedFiles().catch(error => {
    logger.debug(
      `[fileSearch] Warming the file cache failed: ${error instanceof Error ? error.message : String(error)}`
    );
  });
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
      // A Dirent describes the entry, not the link target, so a symlink answers false to
      // BOTH isDirectory() and isFile(). Left unresolved, a symlinked directory listed as
      // a file and stopped offering path completion past it - which is the normal layout
      // under a dotfile manager. stat() follows the link; a broken one throws and keeps
      // the Dirent's answer, so it still lists rather than disappearing.
      const target = entry.isSymbolicLink() ? statOrNull(fullPath) : null;
      const isDirectory = target ? target.isDirectory() : entry.isDirectory();
      const isFile = target ? target.isFile() : entry.isFile();

      const result: FileSearchResult = {
        path: fullPath,
        isDirectory,
      };

      // Add file size if it's a file. Reuses the stat already taken for a symlink so a
      // resolved link costs one syscall, not two.
      if (isFile) {
        const fileStats = target ?? statOrNull(fullPath);
        if (fileStats) {
          result.size = fileStats.size;
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

  const files = await getCachedFiles(projectRoot);

  // If query is empty, return root level items only
  if (!query || query.trim() === '') {
    const rootFiles = files.filter(f => !f.includes('/')).slice(0, maxResults);
    return rootFiles.map(p => describeEntry(projectRoot, p));
  }

  // Use fzf for fuzzy matching
  const fzf = new AsyncFzf(files);
  const results = await fzf.find(query);

  // Take top results and add metadata
  return results.slice(0, maxResults).map((result: FzfResultItem<string>) => describeEntry(projectRoot, result.item));
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
  const isWithin = isPathWithin(normalizedPath, normalizedCwd);

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
