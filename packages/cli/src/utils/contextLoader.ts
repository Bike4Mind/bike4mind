import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';

// Constants
export const CONTEXT_FILE_SIZE_LIMIT = 100 * 1024; // 100KB per file

// Supported file names in priority order (highest priority first)
export const PROJECT_CONTEXT_FILES = [
  'CLAUDE.local.md', // gitignored, highest priority
  'CLAUDE.md',
  'AGENTS.md', // cross-tool standard
  'AI.local.md', // gitignored
  'AI.md',
  'INSTRUCTIONS.md',
] as const;

export const GLOBAL_CONTEXT_FILES = ['AI.local.md', 'AI.md'] as const;

// Types
export interface ContextFileResult {
  filename: string;
  content: string;
  source: 'global' | 'project';
  path: string;
}

export interface ContextLoadResult {
  globalContext: ContextFileResult | null;
  projectContext: ContextFileResult | null;
  mergedContent: string;
  errors: string[];
}

/**
 * Format file size for display
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Try to read a context file from a directory
 *
 * Security: Only reads regular files (not directories or symlinks) within the specified directory.
 * Files must be under 100KB to prevent abuse. Symlinks are rejected to prevent reading
 * files outside the intended directory.
 *
 * @param dir - The directory to read from (must be a controlled location)
 * @param filename - The filename to read (must not contain path separators)
 * @param source - Whether this is a 'global' or 'project' context file
 * @returns The file result, an error object, or null if file doesn't exist
 */
function tryReadContextFile(
  dir: string,
  filename: string,
  source: 'global' | 'project'
): ContextFileResult | { error: string } | null {
  const filePath = path.join(dir, filename);

  try {
    // Get file stats using lstat to detect symlinks
    const stats = fs.lstatSync(filePath);

    // Skip directories
    if (stats.isDirectory()) {
      return null;
    }

    // Security: Skip symlinks to prevent reading files outside intended directory
    if (stats.isSymbolicLink()) {
      return {
        error: `${source === 'global' ? 'Global' : 'Project'} ${filename} is a symlink (not allowed for security)`,
      };
    }

    // Check file size
    if (stats.size > CONTEXT_FILE_SIZE_LIMIT) {
      return {
        error: `${source === 'global' ? 'Global' : 'Project'} ${filename} exceeds 100KB limit (${formatFileSize(stats.size)})`,
      };
    }

    // Read file contents
    const content = fs.readFileSync(filePath, 'utf-8');

    return {
      filename,
      content,
      source,
      path: filePath,
    };
  } catch (err) {
    // File doesn't exist - normal, not an error
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    // Handle permission errors gracefully
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      return {
        error: `Cannot read ${source} ${filename}: permission denied`,
      };
    }

    return {
      error: `Cannot read ${source} ${filename}: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}

/**
 * Find the first context file in a directory from a list of candidates
 */
function findContextFile(
  dir: string,
  candidates: readonly string[],
  source: 'global' | 'project'
): { result: ContextFileResult | null; error: string | null } {
  for (const filename of candidates) {
    const result = tryReadContextFile(dir, filename, source);

    if (result === null) {
      // File doesn't exist, try next candidate
      continue;
    }

    if ('error' in result) {
      // Error reading this file - return error but don't try others
      return { result: null, error: result.error };
    }

    // Found a valid context file
    return { result, error: null };
  }

  // No context files found
  return { result: null, error: null };
}

/**
 * Merge global and project context into a single string
 */
function mergeContextContent(global: ContextFileResult | null, project: ContextFileResult | null): string {
  if (global && project) {
    return `${global.content}\n\n---\n\n${project.content}`;
  }

  if (global) {
    return global.content;
  }

  if (project) {
    return project.content;
  }

  return '';
}

/**
 * Load context files from global and project directories
 *
 * Global files are loaded from ~/.bike4mind/
 * Project files are loaded from the project directory (or cwd if null)
 *
 * Returns the first matching file from each layer based on priority order
 */
export async function loadContextFiles(projectDir: string | null): Promise<ContextLoadResult> {
  const errors: string[] = [];

  // Determine directories
  const globalDir = path.join(homedir(), '.bike4mind');
  const projectDirectory = projectDir || process.cwd();

  // Load global and project context files in parallel
  const [globalResult, projectResult] = await Promise.all([
    Promise.resolve(findContextFile(globalDir, GLOBAL_CONTEXT_FILES, 'global')),
    Promise.resolve(findContextFile(projectDirectory, PROJECT_CONTEXT_FILES, 'project')),
  ]);

  // Collect errors
  if (globalResult.error) {
    errors.push(globalResult.error);
  }
  if (projectResult.error) {
    errors.push(projectResult.error);
  }

  // Merge content
  const mergedContent = mergeContextContent(globalResult.result, projectResult.result);

  return {
    globalContext: globalResult.result,
    projectContext: projectResult.result,
    mergedContent,
    errors,
  };
}

/**
 * Extract "# Compact Instructions" or "## Compact Instructions" section from CLAUDE.md content
 *
 * This section provides project-specific instructions for how conversations should be
 * summarized when compacting context.
 *
 * @param contextContent - The merged context content from CLAUDE.md files
 * @returns The extracted instructions content, or undefined if not found
 */
export function extractCompactInstructions(contextContent: string): string | undefined {
  // Match "# Compact Instructions" or "## Compact Instructions" heading
  const regex = /^#{1,2}\s*Compact\s*Instructions\s*$/im;
  const match = contextContent.match(regex);

  if (!match || match.index === undefined) {
    return undefined;
  }

  // Find content between this heading and next heading (or end)
  const startIndex = match.index + match[0].length;
  const remainingContent = contextContent.slice(startIndex);

  // Find next heading (# or ##)
  const nextHeadingMatch = remainingContent.match(/^#{1,2}\s+\S/m);
  const endIndex = nextHeadingMatch?.index ?? remainingContent.length;

  const content = remainingContent.slice(0, endIndex).trim();

  return content || undefined;
}
