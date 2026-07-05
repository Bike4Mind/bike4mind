import { ChatModels, Permission, isImageServeable } from '@bike4mind/common';
import { FabFile, withTransaction, apiKeyRepository, adminSettingsRepository } from '@bike4mind/database';
import { diffLines } from 'diff';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
import { getSettingsByNames } from '@bike4mind/utils';
import { getAvailableModels, getLlmByModel } from '@bike4mind/llm-adapters';
import { apiKeyService } from '@bike4mind/services';
import { OperationsModelService } from '@client/services/operationsModelService';

const handler = baseApi()
  .use((req, res, next) => {
    if (!req.ability?.can(Permission.update, FabFile)) {
      throw new BadRequestError('Unauthorized');
    }
    next();
  })
  .post(
    asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
      const { user } = req;
      const { id } = req.query;
      const {
        instruction,
        preserveFormatting = true,
        applyImmediately = false,
        model,
      } = req.body as {
        instruction: string;
        preserveFormatting?: boolean;
        applyImmediately?: boolean;
        model?: string;
      };

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Invalid file ID');
      }

      if (!instruction || typeof instruction !== 'string') {
        throw new BadRequestError('Instruction is required');
      }

      // Get the model to use - from request or operations model (faster than session model)
      let modelToUse = model;
      if (!modelToUse) {
        try {
          // Use the operations model which is optimized for fast operations
          const opsModelConfig = await OperationsModelService.getOperationsModelConfig();
          if (opsModelConfig?.modelId) {
            modelToUse = opsModelConfig.modelId;
            console.log(`[Edit API] Using operations model: ${modelToUse}`);
          }
        } catch (error) {
          console.log(`[Edit API] Could not fetch operations model, using default`);
        }
      }
      // Default to Claude Sonnet if no model specified
      if (!modelToUse) {
        modelToUse = ChatModels.CLAUDE_4_6_SONNET_BEDROCK;
      }

      // Check if user has access to this file
      const file = await withTransaction(async () => {
        return FabFile.findById(id).where({ userId: user.id });
      });

      if (!file) {
        throw new NotFoundError('File not found or access denied');
      }

      try {
        // Fetch current file content from S3
        if (!file.filePath) {
          throw new BadRequestError('File has no content');
        }

        console.log(`[Edit API] File details:`, {
          fileId: file.id,
          fileName: file.fileName,
          filePath: file.filePath,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
        });

        // Check if this is a text-based file (mirrors auto-rename.ts's guard - this route
        // sends file bytes to an LLM and must never forward binary/image content).
        const textMimeTypes = [
          'text/plain',
          'text/markdown',
          'text/html',
          'text/csv',
          'application/json',
          'application/javascript',
          'application/typescript',
          'text/x-python',
          'text/x-java',
          'text/x-c',
          'text/x-cpp',
          'text/x-go',
          'text/x-rust',
        ];

        if (!textMimeTypes.includes(file.mimeType || '')) {
          throw new BadRequestError('AI editing is only supported for text-based files');
        }

        // Defense-in-depth: the textMimeTypes allowlist above already excludes
        // image mime types, so this should be unreachable in practice, but if that list is
        // ever loosened (e.g. to include an image-ish text format), never forward the bytes
        // of an uploaded image that isn't clean yet.
        if (!isImageServeable(file)) {
          throw new BadRequestError('File is not available for editing');
        }

        // Use filePath directly as the S3 key
        const s3Key = file.filePath;

        // Always generate a fresh signed URL to avoid expiration issues
        const signedUrl = await getFilesStorage().getSignedUrl(s3Key, 'get', {
          expiresIn: 60,
        });

        console.log(`[Edit API] Generated signed URL for S3 key: ${s3Key}`);

        const contentResponse = await fetch(signedUrl);

        if (!contentResponse.ok) {
          const errorText = await contentResponse.text();
          console.error(`[Edit API] Failed to fetch file content:`, {
            status: contentResponse.status,
            statusText: contentResponse.statusText,
            errorBody: errorText.substring(0, 500),
            filePath: file.filePath,
          });
          throw new BadRequestError('Failed to fetch file content from storage');
        }

        const originalContent = await contentResponse.text();

        // Check if content looks like an XML error
        if (originalContent.startsWith('<?xml') && originalContent.includes('Error')) {
          console.error('[Edit API] S3 returned XML error instead of file content:', originalContent.substring(0, 200));
          throw new BadRequestError('File content is not accessible. The file may have been moved or deleted.');
        }

        // Check file size - limit to 50KB for AI editing
        const contentSize = Buffer.byteLength(originalContent, 'utf8');
        if (contentSize > 50000) {
          throw new BadRequestError(
            `File is too large for AI editing (${Math.round(contentSize / 1024)}KB). Maximum size is 50KB.`
          );
        }

        // Get API keys and initialize LLM
        const dbAdapters = {
          db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository },
          getSettingsByNames,
        };
        const apiKeyTable = await apiKeyService.getEffectiveLLMApiKeys(user.id, dbAdapters);
        const models = await getAvailableModels(apiKeyTable);

        // Find the model
        const modelInfo = models.find(m => m.id === modelToUse);
        if (!modelInfo) {
          throw new BadRequestError(
            `Model "${modelToUse}" is not available. Please select a different model or check your API keys.`
          );
        }

        // Initialize LLM backend
        const llm = getLlmByModel(apiKeyTable, { modelInfo, logger: req.logger, endUserId: req.user?.id });
        if (!llm) {
          throw new BadRequestError(`Failed to initialize model "${modelToUse}". Please check your API keys.`);
        }

        // Generate edit using LLM
        const systemPrompt = `You are a professional file editor. Your task is to edit the provided content according to the user's instruction.

${preserveFormatting ? 'IMPORTANT: Preserve the original formatting, style, and structure as much as possible.' : ''}

Rules:
1. Make ONLY the changes requested by the user
2. Do not add comments or explanations in the edited content
3. Maintain consistency with the existing code style and conventions
4. Preserve indentation and whitespace patterns
5. Return ONLY the edited content, nothing else

File type: ${file.mimeType}
File name: ${file.fileName}`;

        const userPrompt = `Edit the following content according to this instruction: "${instruction}"

Content to edit:
\`\`\`
${originalContent}
\`\`\`

Return only the edited content without any markdown code blocks or explanations.`;

        console.log(`[Edit API] Invoking model: ${modelToUse} (${modelInfo.backend})`);

        let editedContent = '';
        await llm.complete(
          modelInfo.id,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          {
            temperature: 0.3,
            maxTokens: 4000,
            stream: false,
          },
          async (chunks: (string | null | undefined)[]) => {
            // When stream=false, we get the complete response in one callback
            // chunks is an array where chunks[0] contains the full response
            const text = chunks[0];
            if (text) {
              editedContent = text;
            }
          }
        );

        // Clean up the response (remove any markdown code blocks if present)
        editedContent = editedContent.trim();
        editedContent = editedContent.replace(/^```[\w]*\n/, '').replace(/\n```$/, '');

        if (!editedContent) {
          console.error('[Edit API] AI model returned empty response', {
            model: modelToUse,
            backend: modelInfo.backend,
            instructionLength: instruction.length,
            contentLength: originalContent.length,
          });
          throw new BadRequestError('AI model returned empty response. Please try again or select a different model.');
        }

        // Generate diff
        const differences = diffLines(originalContent, editedContent);
        let additions = 0;
        let deletions = 0;
        let changes = 0;
        let diffString = '';

        differences.forEach((part: any) => {
          if (part.added) {
            additions += part.count || 0;
            changes++;
            diffString += part.value
              .split('\n')
              .map((line: string) => `+ ${line}`)
              .join('\n');
          } else if (part.removed) {
            deletions += part.count || 0;
            changes++;
            diffString += part.value
              .split('\n')
              .map((line: string) => `- ${line}`)
              .join('\n');
          } else {
            // Context lines
            const lines = part.value.split('\n').filter((line: string) => line);
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

        const result = {
          fileId: id,
          fileName: file.fileName,
          original: originalContent,
          modified: editedContent,
          diff: {
            additions,
            deletions,
            changes,
            hunks: diffString,
          },
          applied: false,
        };

        // Apply immediately if requested
        if (applyImmediately) {
          await getFilesStorage().upload(editedContent, s3Key, {
            ContentType: file.mimeType || 'text/plain',
          });

          await FabFile.updateOne(
            { _id: file._id },
            {
              $set: {
                updatedAt: new Date(),
                fileSize: Buffer.byteLength(editedContent, 'utf8'),
              },
            }
          );

          result.applied = true;
        }

        return res.json(result);
      } catch (error) {
        console.error('Edit file error:', error);
        throw new BadRequestError(error instanceof Error ? error.message : 'Failed to generate edit');
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
