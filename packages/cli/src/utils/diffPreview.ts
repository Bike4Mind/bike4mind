import * as Diff from 'diff';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fuzzyMatch } from '@bike4mind/services/llm/tools/cliTools';

/**
 * Generate a preview of file changes for permission prompts
 *
 * Shows a unified diff of what will change when edit_file is executed.
 * Returns structured diff data for colored rendering.
 */
export async function generateFileDiffPreview(args: { path: string; content: string }): Promise<string> {
  try {
    // Check if file exists
    if (!existsSync(args.path)) {
      // For new files, show first 20 lines
      const lines = args.content.split('\n');
      const preview = lines.slice(0, 20).join('\n');
      const hasMore = lines.length > 20;

      return `[New file will be created at: ${args.path}]\n\nContent (${lines.length} lines):\n${preview}${
        hasMore ? `\n\n... (${lines.length - 20} more lines)` : ''
      }`;
    }

    // Read current file content
    const currentContent = await readFile(args.path, 'utf-8');

    // Generate unified diff
    const patch = Diff.createPatch(
      args.path,
      currentContent,
      args.content,
      'Current',
      'Proposed',
      { context: 3 } // Show 3 lines of context around changes
    );

    // Extract just the diff lines (skip the header)
    const lines = patch.split('\n');
    const diffLines = lines.slice(4); // Skip file path headers

    // Return full diff (no truncation) - shows only changed sections
    return diffLines.join('\n');
  } catch (error) {
    return `[Error generating diff preview: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}

/**
 * Generate a simple preview for file creation
 */
export function generateFileCreatePreview(args: { path: string; content: string }): string {
  const contentPreview = args.content.substring(0, 500);
  const truncated = args.content.length > 500;

  return `[New file will be created]\n\nPath: ${args.path}\n\nContent:\n${contentPreview}${
    truncated ? '\n\n... (truncated)' : ''
  }`;
}

/**
 * Generate a preview for edit_local_file (string replacement).
 *
 * Shows the ACTUAL span edit_local_file will delete and its replacement, not
 * just the model's typed old_string. A fuzzy fallback match can span more lines
 * than old_string names, so previewing old_string alone would let a wider region
 * be replaced than the user approved. Mirrors the tool's own match order: exact
 * substring first, then the shared fuzzy matcher.
 */
export async function generateEditLocalFilePreview(args: {
  path: string;
  old_string: string;
  new_string: string;
}): Promise<string> {
  let deleted = args.old_string;
  let inserted = args.new_string;

  try {
    if (existsSync(args.path)) {
      const currentContent = await readFile(args.path, 'utf-8');
      if (!currentContent.includes(args.old_string)) {
        // No exact hit - resolve the real fuzzy span the tool would replace.
        const fuzzy = fuzzyMatch(currentContent, args.old_string, args.new_string);
        if (fuzzy) {
          deleted = fuzzy.matchedText;
          inserted = fuzzy.replacement;
        }
      }
    }
  } catch {
    // Fall back to the typed strings on any read/match error (incl. ambiguous match).
  }

  const patch = Diff.createPatch(args.path, deleted, inserted, 'Current', 'Proposed', { context: 3 });

  // Extract just the diff lines (skip the header)
  const lines = patch.split('\n');
  const diffLines = lines.slice(4);

  return `[Edit in: ${args.path}]\n\n${diffLines.join('\n')}`;
}

/**
 * Generate a preview for file deletion
 */
export async function generateFileDeletePreview(args: { path: string }): Promise<string> {
  try {
    if (!existsSync(args.path)) {
      return `[File does not exist: ${args.path}]`;
    }

    const stats = await import('fs/promises').then(fs => fs.stat(args.path));
    return `[File will be deleted]\n\nPath: ${args.path}\nSize: ${stats.size} bytes\nLast modified: ${stats.mtime.toLocaleString()}`;
  } catch (error) {
    return `[Error reading file info: ${error instanceof Error ? error.message : 'Unknown error'}]`;
  }
}
