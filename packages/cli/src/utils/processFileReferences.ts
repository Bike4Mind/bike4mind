import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathAllowed } from '@bike4mind/services/llm/tools/cliTools';
import { isPathWithinCwd, isBinaryFile, MAX_FILE_SIZE, formatFileSize } from './fileSearch.js';
import { extractFileReferences, hasFileReferences } from './fileReferences.js';

export interface ProcessedMessage {
  content: string; // Modified message with context injected
  errors: string[]; // Any errors encountered
}

// Re-exported from here because this has always been their import path; the parsing itself
// moved to fileReferences.js so hosts with their own reader can share it.
export { extractFileReferences, hasFileReferences };

/**
 * Read file contents safely.
 *
 * When `confineTo` is provided (agent-driven references, e.g. the skill tool
 * expanding `@file` in a model- or repo-authored body), every path - absolute
 * included - is confined through the shared realpath validator against the
 * working directory plus those extra allowed dirs, so `@/etc/passwd` is denied.
 * When it is omitted (a human typing `@path` in the prompt), the legacy
 * cwd-relative check applies and absolute paths the user typed are honored.
 */
function readFileContents(
  filePath: string,
  confineTo?: string[]
): { content: string; size: number } | { error: string } {
  const cwd = process.cwd();
  const isAbsolutePath = path.isAbsolute(filePath);

  // Block path traversal attempts (.. components) in all paths
  // Legitimate absolute paths should be explicit, not use .. navigation
  if (filePath.includes('..')) {
    return { error: `Security: Path traversal detected in "${filePath}"` };
  }

  // Agent-driven references: confine every path (absolute too) to the allow-list.
  if (confineTo !== undefined && !isPathAllowed(filePath, confineTo).allowed) {
    return { error: `Access denied: Cannot read files outside allowed directories: "${filePath}"` };
  }

  // Determine absolute path based on whether input is absolute or relative
  const absolutePath = isAbsolutePath ? path.normalize(filePath) : path.resolve(cwd, filePath);

  // For relative paths, additionally verify they resolve within cwd
  // (absolute paths are trusted if they don't contain .. traversal)
  if (confineTo === undefined && !isAbsolutePath && !isPathWithinCwd(filePath)) {
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
export async function processFileReferences(message: string, confineTo?: string[]): Promise<ProcessedMessage> {
  const references = extractFileReferences(message);
  const errors: string[] = [];
  const fileBlocks: string[] = [];

  // Process each reference
  for (const ref of references) {
    const result = readFileContents(ref, confineTo);

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
