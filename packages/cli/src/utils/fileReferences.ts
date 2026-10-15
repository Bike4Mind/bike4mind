import * as path from 'node:path';
import { isNameSuffix } from './constants.js';

/**
 * Recognising `@path` references in a skill or command body, with no filesystem in sight.
 *
 * Split out of processFileReferences so a host that reads and confines files its own way can
 * share the PARSING without pulling in that module's reader (and its `@bike4mind/services`
 * dependency). The desktop app confines `@file` to the session's granted roots rather than to
 * process.cwd(), which is not a directory an Electron app has any business resolving against.
 */

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
 * Check if a message contains any file references
 */
export function hasFileReferences(message: string): boolean {
  FILE_REFERENCE_REGEX.lastIndex = 0;
  return FILE_REFERENCE_REGEX.test(message);
}
