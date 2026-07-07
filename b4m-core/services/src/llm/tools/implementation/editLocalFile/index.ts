import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { diffLines, type Change } from 'diff';
import { assertPathAllowed } from '../../utils/pathValidation';
import { fuzzyMatch, type FuzzyStrategy } from './fuzzyMatch';

interface EditLocalFileParams {
  path: string;
  old_string: string;
  new_string: string;
}

interface EditLocalFileResult {
  /** Human/model-facing summary of the edit (success message + diff). */
  message: string;
  /** Set when the edit was resolved via the fuzzy fallback rather than an exact match. */
  strategy?: FuzzyStrategy;
}

interface DiffResult {
  additions: number;
  deletions: number;
  diff: string;
}

function generateDiff(original: string, modified: string): DiffResult {
  const differences = diffLines(original, modified);
  let diffString = '';
  let additions = 0;
  let deletions = 0;

  differences.forEach((part: Change) => {
    if (part.added) {
      additions += part.count || 0;
      diffString += part.value
        .split('\n')
        .filter(line => line)
        .map((line: string) => `+ ${line}`)
        .join('\n');
      if (diffString && !diffString.endsWith('\n')) diffString += '\n';
    } else if (part.removed) {
      deletions += part.count || 0;
      diffString += part.value
        .split('\n')
        .filter(line => line)
        .map((line: string) => `- ${line}`)
        .join('\n');
      if (diffString && !diffString.endsWith('\n')) diffString += '\n';
    }
  });

  return { additions, deletions, diff: diffString.trim() };
}

async function editLocalFile(params: EditLocalFileParams, allowedDirectories?: string[]): Promise<EditLocalFileResult> {
  const { path: filePath, old_string, new_string } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'edit');

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const currentContent = await fs.readFile(resolvedPath, 'utf-8');

  // The span of the file we will replace, and what we will replace it with.
  // The exact fast path is unchanged; a validated fuzzy fallback (indentation,
  // blank-line, whitespace-width, and escape drift) only runs after it misses.
  let startIndex: number;
  let matchedText: string;
  let replacement: string;
  let strategy: FuzzyStrategy | undefined;

  if (currentContent.includes(old_string)) {
    const occurrences = currentContent.split(old_string).length - 1;
    if (occurrences > 1) {
      throw new Error(
        `Found ${occurrences} occurrences of the string to replace. ` +
          `Please provide a more specific old_string that matches exactly one location.`
      );
    }
    startIndex = currentContent.indexOf(old_string);
    matchedText = old_string;
    replacement = new_string;
  } else {
    // Throws AmbiguousMatchError / DisproportionateMatchError with actionable
    // messages; returns null when no tolerant matcher resolves the block.
    const fuzzy = fuzzyMatch(currentContent, old_string, new_string);
    if (!fuzzy) {
      const preview = old_string.length > 100 ? old_string.substring(0, 100) + '...' : old_string;
      throw new Error(
        `String to replace not found in file. ` +
          `Make sure the old_string matches exactly (including whitespace and line endings). ` +
          `Searched for: "${preview}"`
      );
    }
    startIndex = fuzzy.startIndex;
    matchedText = fuzzy.matchedText;
    replacement = fuzzy.replacement;
    strategy = fuzzy.strategy;
  }

  const newContent =
    currentContent.slice(0, startIndex) + replacement + currentContent.slice(startIndex + matchedText.length);

  await fs.writeFile(resolvedPath, newContent, 'utf-8');

  // Generate diff for feedback against the span actually replaced.
  const diffResult = generateDiff(matchedText, replacement);

  // When the exact match missed, tell the model its old_string drifted so it can
  // be more precise next time (indentation and line endings were preserved).
  const fuzzyNote = strategy
    ? `\n\nNote: old_string was not an exact match; it was resolved with a fuzzy fallback (${strategy}), ` +
      `preserving the file's original indentation and line endings.`
    : '';

  const message =
    `File edited successfully: ${filePath}\n` +
    `Changes: +${diffResult.additions} lines, -${diffResult.deletions} lines\n` +
    `\nDiff:\n${diffResult.diff}${fuzzyNote}`;

  return { message, strategy };
}

export const editLocalFileTool: ToolDefinition = {
  name: 'edit_local_file',
  implementation: context => ({
    toolFn: async value => {
      const params = value as EditLocalFileParams;

      context.logger.info(`📝 EditLocalFile: Editing file`, {
        path: params.path,
        oldStringLength: params.old_string.length,
        newStringLength: params.new_string.length,
      });

      try {
        const { message, strategy } = await editLocalFile(params, context.allowedDirectories);
        context.logger.info('✅ EditLocalFile: Success', {
          path: params.path,
          matchType: strategy ?? 'exact',
        });
        return message;
      } catch (error) {
        context.logger.error('❌ EditLocalFile: Failed', error);
        throw error;
      }
    },
    toolSchema: {
      name: 'edit_local_file',
      description:
        'Edit a file by replacing a specific string with new content. ' +
        'The old_string must match exactly one location in the file (including whitespace). ' +
        'Use this for precise edits to existing files. ' +
        'For creating new files or complete rewrites, use create_file instead.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit (relative to current working directory)',
          },
          old_string: {
            type: 'string',
            description:
              'The exact string to find and replace. Must match exactly one location in the file, including all whitespace and line endings.',
          },
          new_string: {
            type: 'string',
            description: 'The string to replace old_string with. Can be empty to delete the old_string.',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  }),
};
