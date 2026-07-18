import { ToolDefinition } from '../../base/types';
import { recordToolOperationalUsage } from '../../base/recordToolOperationalUsage';
import { z } from 'zod';
import { NotFoundError } from '@bike4mind/utils';
import { isImageServeable } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { diffLines, type Change } from 'diff';

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- consumed via z.infer<typeof editFileSchema> at the type level; schema name is API contract
const editFileSchema = z.object({
  fileId: z.string().describe('The ID of the file to edit'),
  instruction: z.string().describe('Natural language instruction describing the changes to make'),
  selection: z
    .object({
      start: z.number().describe('Starting character position of the selection'),
      end: z.number().describe('Ending character position of the selection'),
    })
    .optional()
    .describe('Optional selection range to edit within the file'),
  preserveFormatting: z
    .boolean()
    .optional()
    .prefault(true)
    .describe('Whether to preserve the original formatting style'),
  returnDiff: z.boolean().optional().prefault(true).describe('Whether to return a diff of the changes'),
});

type EditFileParams = z.infer<typeof editFileSchema>;

interface DiffResult {
  original: string;
  modified: string;
  diff: string;
  additions: number;
  deletions: number;
  changes: number;
}

function generateSimpleDiff(original: string, modified: string): DiffResult {
  const differences = diffLines(original, modified);
  let diffString = '';
  let additions = 0;
  let deletions = 0;
  let changes = 0;

  differences.forEach((part: Change) => {
    if (part.added) {
      additions += part.count || 0;
      changes++;
      diffString += part.value
        .split('\n')
        .map((line: string) => (line ? `+ ${line}` : '+'))
        .join('\n');
    } else if (part.removed) {
      deletions += part.count || 0;
      changes++;
      diffString += part.value
        .split('\n')
        .map((line: string) => (line ? `- ${line}` : '-'))
        .join('\n');
    } else {
      // Context lines (unchanged)
      const lines = part.value.split('\n');
      // Show up to 3 context lines around changes
      if (lines.length > 6) {
        diffString += lines
          .slice(0, 3)
          .map((line: string) => `  ${line}`)
          .join('\n');
        diffString += '\n  ...\n';
        diffString += lines
          .slice(-3)
          .map((line: string) => `  ${line}`)
          .join('\n');
      } else {
        diffString += lines.map((line: string) => `  ${line}`).join('\n');
      }
    }
  });

  return {
    original,
    modified,
    diff: diffString,
    additions,
    deletions,
    changes,
  };
}

export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  implementation: context => ({
    toolFn: async (parameters?: unknown) => {
      const params = parameters as EditFileParams;
      const { fileId, instruction, selection, preserveFormatting, returnDiff } = params;

      context.logger.info(`📝 Edit File Tool: Starting edit for file ${fileId}`);
      context.logger.info(`📝 Edit File Tool: Instruction: ${instruction}`);

      try {
        // context.db's type doesn't expose fabFiles; reached via the cast below.
        const fabFile = await (context.db as any).fabFiles?.findById(fileId);
        if (!fabFile) {
          throw new NotFoundError(`File with ID ${fileId} not found`);
        }

        // Check if file has content
        if (!fabFile || (!fabFile.fileUrl && !fabFile.filePath)) {
          throw new Error('File has no content to edit');
        }

        // Refuse to fetch bytes for a held/blocked uploaded image.
        if (fabFile && !isImageServeable(fabFile)) {
          throw new Error('This image is not available.');
        }

        // Get the content to edit
        let contentToEdit = '';

        // Fetch content from URL
        if (fabFile.fileUrl) {
          context.logger.info(`📝 Edit File Tool: Fetching content from URL for file ${fileId}`);
          try {
            const response = await fetch(fabFile.fileUrl);
            if (!response.ok) {
              throw new Error(`Failed to fetch file content: ${response.statusText}`);
            }
            contentToEdit = await response.text();
          } catch (error) {
            context.logger.error(`📝 Edit File Tool: Failed to fetch file content`, error);
            throw new Error('Could not retrieve file content for editing');
          }
        }

        // Extract selection if provided
        if (selection) {
          contentToEdit = contentToEdit.slice(selection.start, selection.end);
          context.logger.info(`📝 Edit File Tool: Editing selection from ${selection.start} to ${selection.end}`);
        }

        // Build the prompt for the LLM
        const systemPrompt = `You are a professional file editor. Your task is to edit the provided content according to the user's instruction.

${preserveFormatting ? 'IMPORTANT: Preserve the original formatting, style, and structure as much as possible.' : ''}

Rules:
1. Make ONLY the changes requested by the user
2. Do not add comments or explanations in the edited content
3. Maintain consistency with the existing code style and conventions
4. Preserve indentation and whitespace patterns
5. Return ONLY the edited content, nothing else

File type: ${fabFile.mimeType}
File name: ${fabFile.fileName}`;

        const userPrompt = `Edit the following content according to this instruction: "${instruction}"

Content to edit:
\`\`\`
${contentToEdit}
\`\`\`

Return only the edited content without any markdown code blocks or explanations.`;

        // Call the LLM to perform the edit
        context.logger.info(`📝 Edit File Tool: Calling LLM for edit generation`);

        let editedContent = '';
        let completionInfo: CompletionInfo | undefined;
        // The backend uses whatever model id is passed here (the interface's `model` arg
        // is authoritative), so record this same id for the usage event.
        const editModel = 'gpt-4';
        const startTime = Date.now();
        await context.llm.complete(
          editModel,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          { temperature: 0.3, stream: false }, // Lower temperature for more consistent edits
          async (texts, info) => {
            editedContent = texts.filter(t => t !== null && t !== undefined).join('');
            if (info) completionInfo = info;
          }
        );

        await recordToolOperationalUsage(context, { model: editModel, completionInfo, startTime });

        // Clean up the response (remove any markdown code blocks if present)
        let cleanedContent = (editedContent || '').trim();
        // Remove markdown code blocks if the LLM added them despite instructions
        cleanedContent = cleanedContent.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');

        // If we edited a selection, merge it back
        let finalContent = cleanedContent;
        if (selection && contentToEdit) {
          const originalContent = contentToEdit;
          finalContent =
            originalContent.slice(0, selection.start) + cleanedContent + originalContent.slice(selection.end);
        }

        // Generate diff if requested
        let diffResult: DiffResult | undefined;
        if (returnDiff) {
          diffResult = generateSimpleDiff(
            selection ? contentToEdit : contentToEdit,
            selection ? cleanedContent : finalContent
          );
        }

        // Prepare the response
        const result = {
          success: true,
          fileId,
          fileName: fabFile.fileName,
          original: contentToEdit,
          modified: finalContent,
          instruction,
          ...(diffResult && { diff: diffResult }),
        };

        context.logger.info(`📝 Edit File Tool: Edit completed successfully for file ${fileId}`);
        context.logger.info(
          `📝 Edit File Tool: Changes: +${diffResult?.additions || 0} -${diffResult?.deletions || 0}`
        );

        // Update status if needed
        await context.statusUpdate({}, `File edit preview ready for ${fabFile.fileName}`);

        return JSON.stringify(result, null, 2);
      } catch (error) {
        context.logger.error(`📝 Edit File Tool: Error editing file`, error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        throw new Error(`Failed to edit file: ${errorMessage}`);
      }
    },
    toolSchema: {
      name: 'edit_file',
      description:
        'Edit the content of a file using natural language instructions. Can edit entire files or specific selections.',
      parameters: {
        type: 'object',
        properties: {
          fileId: {
            type: 'string',
            description: 'The ID of the file to edit',
          },
          instruction: {
            type: 'string',
            description: 'Natural language instruction describing the changes to make',
          },
          selection: {
            type: 'object',
            properties: {
              start: {
                type: 'number',
                description: 'Starting character position of the selection',
              },
              end: {
                type: 'number',
                description: 'Ending character position of the selection',
              },
            },
            required: ['start', 'end'],
            description: 'Optional selection range to edit within the file',
          },
          preserveFormatting: {
            type: 'boolean',
            description: 'Whether to preserve the original formatting style (default: true)',
          },
          returnDiff: {
            type: 'boolean',
            description: 'Whether to return a diff of the changes (default: true)',
          },
        },
        required: ['fileId', 'instruction'],
      },
    },
  }),
};
