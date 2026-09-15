import { Permission } from '@bike4mind/common';
import { FabFile, withTransaction } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, InternalServerError } from '@bike4mind/utils';
import { getFilesStorage } from '@server/utils/storage';
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

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Invalid file ID');
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

        console.log(`[Auto-Rename API] File details:`, {
          fileId: file.id,
          fileName: file.fileName,
          filePath: file.filePath,
          mimeType: file.mimeType,
          fileSize: file.fileSize,
        });

        // Check if this is a text-based file
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
          throw new BadRequestError('Automatic renaming is only supported for text-based files');
        }

        // Use filePath directly as the S3 key
        const s3Key = file.filePath;

        // Always generate a fresh signed URL to avoid expiration issues
        const signedUrl = await getFilesStorage().getSignedUrl(s3Key, 'get', {
          expiresIn: 60,
        });

        console.log(`[Auto-Rename API] Generated signed URL for S3 key: ${s3Key}`);

        const contentResponse = await fetch(signedUrl);

        if (!contentResponse.ok) {
          const errorText = await contentResponse.text();
          console.error(`[Auto-Rename API] Failed to fetch file content:`, {
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
          console.error(
            '[Auto-Rename API] S3 returned XML error instead of file content:',
            originalContent.substring(0, 200)
          );
          throw new BadRequestError('File content is not accessible. The file may have been moved or deleted.');
        }

        // Check file size - limit to 100KB for content analysis
        const contentSize = Buffer.byteLength(originalContent, 'utf8');
        if (contentSize > 100000) {
          throw new BadRequestError(
            `File is too large for automatic renaming (${Math.round(contentSize / 1024)}KB). Maximum size is 100KB.`
          );
        }

        // Get the operations model (optimized for fast operations like gpt-4o-mini)
        const { llm, modelId } = await OperationsModelService.getOperationsModel();

        // Get file extension to preserve it (including compound extensions like .tar.gz, .test.ts)
        const getFileExtension = (filename: string): string => {
          if (!filename || !filename.includes('.')) return '';

          const parts = filename.split('.');

          // Handle compound extensions
          const compoundExtensions = [
            'tar.gz',
            'tar.bz2',
            'tar.xz',
            'tar.zst',
            'test.ts',
            'test.tsx',
            'test.js',
            'test.jsx',
            'spec.ts',
            'spec.tsx',
            'spec.js',
            'spec.jsx',
            'd.ts',
            'config.js',
            'config.ts',
          ];

          if (parts.length >= 3) {
            const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
            if (compoundExtensions.includes(lastTwo.toLowerCase())) {
              return `.${lastTwo}`;
            }
          }

          // Single extension
          return `.${parts[parts.length - 1]}`;
        };

        const fileExtension = getFileExtension(file.fileName || '');

        // Truncate content if too long (use first 8000 characters for analysis)
        const contentToAnalyze =
          originalContent.length > 8000
            ? originalContent.substring(0, 8000) + '\n\n[Content truncated for analysis...]'
            : originalContent;

        // Generate filename suggestion using LLM
        const prompt = `Generate a concise, descriptive filename for this content. The filename should be 2-6 words long, using kebab-case (words separated by hyphens).

Rules:
- Use only lowercase letters, numbers, and hyphens
- Do NOT include the file extension
- Avoid generic names like "document", "file", or "text"
- Be specific and descriptive
- Return ONLY the filename, nothing else

File type: ${file.mimeType}
Current name: ${file.fileName}

Content:
\`\`\`
${contentToAnalyze}
\`\`\`

Return only the filename (without extension) in kebab-case:`;

        console.log(`[Auto-Rename API] Invoking model: ${modelId}`);

        // Add timeout handling for LLM request
        let suggestedName = '';
        const llmPromise = llm.complete(
          modelId,
          [{ role: 'user', content: prompt }],
          {
            temperature: 0.3,
            maxTokens: 100,
          },
          async (chunks: (string | null | undefined)[]) => {
            suggestedName += chunks.filter(Boolean).join('');
          }
        );

        // Set a 30-second timeout for the LLM request
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('AI request timed out. Please try again.')), 30000);
        });

        try {
          await Promise.race([llmPromise, timeoutPromise]);
        } catch (error) {
          if (error instanceof Error && error.message.includes('timed out')) {
            throw new InternalServerError('AI request timed out. Please try again.');
          }
          throw error;
        }

        // Clean up the response
        suggestedName = suggestedName.trim().toLowerCase();

        // Remove any quotes or markdown
        suggestedName = suggestedName.replace(/["`']/g, '');

        // Remove any file extensions that might have been added
        suggestedName = suggestedName.replace(/\.(txt|md|json|csv|html|js|ts|py|java|c|cpp|go|rs)$/i, '');

        // Ensure kebab-case (replace spaces and underscores with hyphens)
        suggestedName = suggestedName.replace(/[\s_]+/g, '-');

        // Remove any invalid characters
        suggestedName = suggestedName.replace(/[^a-z0-9-]/g, '');

        // Remove multiple consecutive hyphens
        suggestedName = suggestedName.replace(/-+/g, '-');

        // Remove leading/trailing hyphens
        suggestedName = suggestedName.replace(/^-+|-+$/g, '');

        if (!suggestedName || suggestedName.length < 2) {
          console.error('[Auto-Rename API] AI model returned invalid filename', {
            model: modelId,
            rawResponse: suggestedName,
            contentLength: originalContent.length,
          });
          throw new InternalServerError(
            'AI model could not generate a valid filename. Please try again or rename manually.'
          );
        }

        // Add the file extension back
        let suggestedFileName = suggestedName + fileExtension;

        // Check for duplicate filenames and suggest alternatives if needed
        const checkDuplicate = async (filename: string): Promise<string> => {
          const existingFile = await FabFile.findOne({
            userId: user.id,
            fileName: filename,
            _id: { $ne: file._id }, // Exclude the current file
          }).lean();

          if (!existingFile) {
            return filename;
          }

          // Generate alternatives by appending numbers
          let counter = 2;
          let alternativeFileName = '';
          const baseName = filename.substring(0, filename.length - fileExtension.length);

          while (counter <= 10) {
            alternativeFileName = `${baseName}-${counter}${fileExtension}`;
            const duplicate = await FabFile.findOne({
              userId: user.id,
              fileName: alternativeFileName,
              _id: { $ne: file._id },
            }).lean();

            if (!duplicate) {
              return alternativeFileName;
            }
            counter++;
          }

          // If we can't find a unique name after 10 tries, throw an error
          throw new InternalServerError('Could not generate a unique filename. Please rename the file manually.');
        };

        suggestedFileName = await checkDuplicate(suggestedFileName);

        console.log(`[Auto-Rename API] Generated filename: ${suggestedFileName}`);

        // Return the suggestion without applying it
        return res.json({
          fileId: id,
          currentName: file.fileName,
          suggestedName: suggestedFileName,
          model: modelId,
        });
      } catch (error) {
        console.error('Auto-rename error:', error);
        throw new BadRequestError(error instanceof Error ? error.message : 'Failed to auto-rename file');
      }
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
