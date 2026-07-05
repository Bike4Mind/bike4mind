import path from 'path';
import { realpathSync } from 'fs';

/**
 * Result of path validation check
 */
export interface PathValidationResult {
  allowed: boolean;
  resolvedPath: string;
  matchedDirectory?: string;
}

/**
 * Resolves a path to its canonical form, following symlinks.
 * If the path doesn't exist (e.g., file being created), resolves the
 * nearest existing ancestor and appends the remaining segments.
 */
function resolveRealPath(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    // Path doesn't exist yet - resolve the parent directory instead
    const parentDir = path.dirname(filePath);
    const basename = path.basename(filePath);
    if (parentDir === filePath) {
      // Reached filesystem root, just return the path as-is
      return filePath;
    }
    return path.join(resolveRealPath(parentDir), basename);
  }
}

/**
 * Validates if a path is within any of the allowed directories.
 * Always includes process.cwd() as an allowed directory.
 * Resolves symlinks to prevent symlink-based directory escapes.
 *
 * @param filePath - The path to validate (can be relative or absolute)
 * @param allowedDirectories - Optional list of additional allowed directories
 * @returns Object with validation result, resolved path, and matched directory if allowed
 */
export function isPathAllowed(filePath: string, allowedDirectories?: string[]): PathValidationResult {
  const cwd = resolveRealPath(process.cwd());
  const allAllowed = [cwd, ...(allowedDirectories || []).map(d => resolveRealPath(d))];

  const normalizedPath = path.normalize(filePath);

  // Handle both absolute and relative paths, then resolve symlinks
  const logicalPath = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(cwd, normalizedPath);
  const resolvedPath = resolveRealPath(logicalPath);

  // Check if resolved path is within any allowed directory
  for (const dir of allAllowed) {
    // Path is allowed if it equals the directory or is a child
    if (resolvedPath === dir || resolvedPath.startsWith(dir + path.sep)) {
      return { allowed: true, resolvedPath, matchedDirectory: dir };
    }
  }

  return { allowed: false, resolvedPath };
}

/**
 * Throws an error if the path is not within allowed directories.
 *
 * @param filePath - The path to validate
 * @param allowedDirectories - Optional list of additional allowed directories
 * @param operation - Description of the operation (for error message), e.g., 'read', 'write', 'delete'
 * @returns The resolved absolute path if allowed
 * @throws Error if path is not within allowed directories
 */
export function assertPathAllowed(filePath: string, allowedDirectories?: string[], operation = 'access'): string {
  const result = isPathAllowed(filePath, allowedDirectories);

  if (!result.allowed) {
    const cwd = process.cwd();
    const dirsMsg =
      allowedDirectories && allowedDirectories.length > 0
        ? `Allowed directories: ${[cwd, ...allowedDirectories].join(', ')}`
        : `Working directory: ${cwd}`;
    throw new Error(`Access denied: Cannot ${operation} files outside allowed directories. ${dirsMsg}`);
  }

  return result.resolvedPath;
}
