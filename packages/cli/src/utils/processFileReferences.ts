import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathWithinCwd, isBinaryFile, MAX_FILE_SIZE, formatFileSize } from './fileSearch.js';
import { isNameSuffix } from './constants.js';

export interface ProcessedMessage {
  content: string; // Modified message with context injected
  errors: string[]; // Any errors encountered
}

/**
 * Regular expression to match @path references
 * Matches @ followed by a path-like string (not containing spaces)
 * Only matches @ at start of string or after whitespace
 */
const FILE_REFERENCE_REGEX = /(?:^|\s)@([^\s@]+)/g;

/**
 * Check if a string looks like a file path (not an email or username)
 * A file path contains / or . (file extension) at the end
 */
function looksLikeFilePath(ref: string): boolean {
  // Contains path separator - definitely a path
  if (ref.includes('/') || ref.includes(path.sep)) {
    return true;
  }

  // Has a file extension pattern (ends with .something)
  const extensionMatch = /\.(\w+)$/.exec(ref);
  if (extensionMatch) {
    const ext = extensionMatch[1].toLowerCase();

    // Exclude common human name suffixes (jr, sr, ii, iii, etc.)
    if (isNameSuffix(ext)) {
      return false;
    }

    // Exclude very long "extensions" (unlikely to be real file extensions)
    if (ext.length > 10) {
      return false;
    }

    return true;
  }

  return false;
}

/**
 * Extract all file references from a message
 * Only treats @reference as a file if it looks like a path (contains / or has file extension)
 */
export function extractFileReferences(message: string): string[] {
  const references: string[] = [];
  FILE_REFERENCE_REGEX.lastIndex = 0; // Reset regex state for fresh iteration
  let match;

  while ((match = FILE_REFERENCE_REGEX.exec(message)) !== null) {
    const ref = match[1];
    // Only treat as file reference if it looks like a path
    // Must contain / or . (file extension) to be considered a file path
    if (looksLikeFilePath(ref)) {
      references.push(ref);
    }
  }

  return references;
}

/**
 * Read file contents safely
 */
function readFileContents(filePath: string): { content: string; size: number } | { error: string } {
  const cwd = process.cwd();
  const isAbsolutePath = path.isAbsolute(filePath);

  // Block path traversal attempts (.. components) in all paths
  // Legitimate absolute paths should be explicit, not use .. navigation
  if (filePath.includes('..')) {
    return { error: `Security: Path traversal detected in "${filePath}"` };
  }

  // Determine absolute path based on whether input is absolute or relative
  const absolutePath = isAbsolutePath ? path.normalize(filePath) : path.resolve(cwd, filePath);

  // For relative paths, additionally verify they resolve within cwd
  // (absolute paths are trusted if they don't contain .. traversal)
  if (!isAbsolutePath && !isPathWithinCwd(filePath)) {
    return { error: `Security: Relative path "${filePath}" escapes the current working directory` };
  }

  // Check if path exists
  if (!fs.existsSync(absolutePath)) {
    return { error: `File not found: "${filePath}"` };
  }

  // Get file stats
  const stats = fs.statSync(absolutePath);

  // Handle directories
  if (stats.isDirectory()) {
    try {
      const entries = fs.readdirSync(absolutePath);
      const fileCount = entries.length;
      return {
        content: `(Directory with ${fileCount} items. Use file tools to explore if needed.)`,
        size: 0,
      };
    } catch (err) {
      return { error: `Cannot read directory "${filePath}": ${err instanceof Error ? err.message : 'Unknown error'}` };
    }
  }

  // Check file size
  if (stats.size > MAX_FILE_SIZE) {
    return {
      error: `File too large: "${filePath}" is ${formatFileSize(stats.size)} (max ${formatFileSize(MAX_FILE_SIZE)})`,
    };
  }

  // Check if binary
  if (isBinaryFile(filePath)) {
    return { error: `Binary file: "${filePath}" cannot be included as text content` };
  }

  // Read file contents
  try {
    const content = fs.readFileSync(absolutePath, 'utf-8');
    return { content, size: stats.size };
  } catch (err) {
    return { error: `Cannot read file "${filePath}": ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

/**
 * Format file content block for injection
 */
function formatFileBlock(filePath: string, content: string, size: number, isDirectory: boolean): string {
  if (isDirectory) {
    return `
--- Directory Reference: ${filePath} ---
${content}
--- End of ${filePath} ---`;
  }

  return `
--- Referenced File: ${filePath} (${formatFileSize(size)}) ---
${content}
--- End of ${filePath} ---`;
}

/**
 * Process file references in a message
 * Extracts @path references and injects file contents
 */
export async function processFileReferences(message: string): Promise<ProcessedMessage> {
  const references = extractFileReferences(message);
  const errors: string[] = [];
  const fileBlocks: string[] = [];

  // Process each reference
  for (const ref of references) {
    const result = readFileContents(ref);

    if ('error' in result) {
      errors.push(result.error);
      continue;
    }

    // Check if it's a directory (size 0 indicates our directory marker)
    const isDirectory = result.size === 0 && result.content.startsWith('(Directory');

    fileBlocks.push(formatFileBlock(ref, result.content, result.size, isDirectory));
  }

  // If no file blocks were generated, return original message
  if (fileBlocks.length === 0) {
    return { content: message, errors };
  }

  // Combine original message with file blocks
  const processedContent = message + '\n' + fileBlocks.join('\n');

  return { content: processedContent, errors };
}

/**
 * Check if a message contains any file references
 */
export function hasFileReferences(message: string): boolean {
  FILE_REFERENCE_REGEX.lastIndex = 0;
  return FILE_REFERENCE_REGEX.test(message);
}
