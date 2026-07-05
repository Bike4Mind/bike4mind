import { ToolDefinition } from '../../base/types';
import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { diffLines, type Change } from 'diff';
import { assertPathAllowed } from '../../utils/pathValidation';

interface EditLocalFileParams {
  path: string;
  old_string: string;
  new_string: string;
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

async function editLocalFile(params: EditLocalFileParams, allowedDirectories?: string[]): Promise<string> {
  const { path: filePath, old_string, new_string } = params;

  // Validate path is within allowed directories (cwd is always included)
  const resolvedPath = assertPathAllowed(filePath, allowedDirectories, 'edit');

  // Check if file exists
  if (!existsSync(resolvedPath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const currentContent = await fs.readFile(resolvedPath, 'utf-8');

  // Validate that old_string exists in the file
  if (!currentContent.includes(old_string)) {
    // Provide helpful error message
    const preview = old_string.length > 100 ? old_string.substring(0, 100) + '...' : old_string;
    throw new Error(
      `String to replace not found in file. ` +
        `Make sure the old_string matches exactly (including whitespace and line endings). ` +
        `Searched for: "${preview}"`
    );
  }

  // Count occurrences
  const occurrences = currentContent.split(old_string).length - 1;
  if (occurrences > 1) {
    throw new Error(
      `Found ${occurrences} occurrences of the string to replace. ` +
        `Please provide a more specific old_string that matches exactly one location.`
    );
  }

  const newContent = currentContent.replace(old_string, new_string);

  await fs.writeFile(resolvedPath, newContent, 'utf-8');

  // Generate diff for feedback
  const diffResult = generateDiff(old_string, new_string);

  return (
    `File edited successfully: ${filePath}\n` +
    `Changes: +${diffResult.additions} lines, -${diffResult.deletions} lines\n` +
    `\nDiff:\n${diffResult.diff}`
  );
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
        const result = await editLocalFile(params, context.allowedDirectories);
        context.logger.info('✅ EditLocalFile: Success', { path: params.path });
        return result;
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
