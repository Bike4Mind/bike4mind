import { IFabFileDocument, IFabFileRepository, IUserDocument, isImageServeable } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';
import { diffLines, type Change } from 'diff';

const editFabFileSchema = z.object({
  id: z.string(),
  instruction: z.string(),
  selection: z
    .object({
      start: z.number(),
      end: z.number(),
    })
    .optional(),
  preserveFormatting: z.boolean().optional().prefault(true),
  applyImmediately: z.boolean().optional().prefault(false),
});

type EditFabFileParameters = z.infer<typeof editFabFileSchema>;

interface EditFabFileAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update' | 'findById'>;
  };
  llm?: {
    complete: (options: {
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
    }) => Promise<string>;
  };
  storage?: {
    upload: (filePath: string, content: string, metadata?: Record<string, unknown>) => Promise<unknown>;
    generateSignedUrl: (path: string, expireInSeconds: number) => Promise<string>;
  };
}

export interface EditResult {
  fileId: string;
  fileName: string;
  original: string;
  modified: string;
  diff: {
    additions: number;
    deletions: number;
    changes: number;
    hunks: string;
  };
  applied: boolean;
}

/**
 * Generate a diff between two text strings
 */
function generateDiff(original: string, modified: string) {
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
    additions,
    deletions,
    changes,
    hunks: diffString,
  };
}

/**
 * Edit a FabFile using AI-powered natural language instructions
 * This returns a preview of the edit unless applyImmediately is true
 */
export const editFabFile = async (
  user: IUserDocument,
  parameters: EditFabFileParameters,
  { db, llm, storage }: EditFabFileAdapters
): Promise<EditResult> => {
  const { id, instruction, selection, preserveFormatting, applyImmediately } = secureParameters(
    parameters,
    editFabFileSchema
  );

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, id);
  if (!fabFile) throw new NotFoundError('File not found or access denied');

  // This service function has no live caller today (the gated route at
  // pages/api/fabfiles/[id]/edit.ts reimplements its own logic), but it is exported
  // from the fabFileService barrel, so a future/internal caller could still reach it.
  // Refuse to read/return or overwrite a held/blocked uploaded image's bytes.
  if (!isImageServeable(fabFile)) throw new BadRequestError('File is not available for editing');

  if (!fabFile.fileUrl && !fabFile.filePath) {
    throw new Error('File has no content to edit');
  }

  let contentToEdit = '';

  if (fabFile.fileUrl) {
    try {
      const response = await fetch(fabFile.fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch file content: ${response.statusText}`);
      }
      contentToEdit = await response.text();
    } catch (error) {
      throw new Error('Could not retrieve file content for editing');
    }
  }

  let selectedContent = contentToEdit;
  if (selection) {
    selectedContent = contentToEdit.slice(selection.start, selection.end);
  }

  if (!llm) {
    throw new Error('LLM service is required for file editing');
  }

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
${selectedContent}
\`\`\`

Return only the edited content without any markdown code blocks or explanations.`;

  const editedContent = await llm.complete({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3, // Lower temperature for more consistent edits
  });

  let cleanedContent = editedContent.trim();
  // Remove markdown code blocks if the LLM added them despite instructions
  cleanedContent = cleanedContent.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');

  // If we edited a selection, merge it back
  let finalContent = cleanedContent;
  if (selection) {
    finalContent = contentToEdit.slice(0, selection.start) + cleanedContent + contentToEdit.slice(selection.end);
  }

  const diff = generateDiff(selection ? selectedContent : contentToEdit, selection ? cleanedContent : finalContent);

  let applied = false;
  if (applyImmediately && storage) {
    const filePath = fabFile.filePath || `${fabFile.id}.txt`;

    await storage.upload(filePath, finalContent, {
      ContentType: fabFile.mimeType,
    });

    const updatedFile: Partial<IFabFileDocument> = {
      ...fabFile,
      fileUrl: await storage.generateSignedUrl(filePath, 3600),
      fileUrlExpireAt: new Date(Date.now() + 3600 * 1000),
      filePath,
      updatedAt: new Date(),
    };

    await db.fabFiles.update(updatedFile);
    applied = true;
  }

  return {
    fileId: fabFile.id,
    fileName: fabFile.fileName,
    original: contentToEdit,
    modified: finalContent,
    diff,
    applied,
  };
};
