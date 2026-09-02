import { notebookExportService } from '@bike4mind/services';
import { Logger } from '@bike4mind/observability';
import {
  sessionRepository,
  questRepository,
  fabFileRepository,
  artifactRepository,
  agentRepository,
  Tool,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { getFilesStorage } from '@server/utils/storage';
import { z } from 'zod';
import { NotebookExportRequestSchema } from '../../../types/api';

const { NotebookExportService, NotebookExportError } = notebookExportService;
type NotebookExportOptions = Parameters<typeof NotebookExportService.prototype.exportNotebooks>[1];

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'User not authenticated',
      });
    }

    let validatedBody: z.infer<typeof NotebookExportRequestSchema>;
    try {
      validatedBody = NotebookExportRequestSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        // The service is never reached on this path, so without this line the most common caller
        // fault - a malformed notebook id - would 400 and leave no trace anywhere.
        req.logger.warn('Notebook export rejected at the schema', {
          userId,
          fields: error.issues.map(err => err.path.join('.')),
        });
        return res.status(400).json({
          success: false,
          message: 'Invalid request body',
          errors: error.issues.map(err => ({
            field: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      throw error;
    }

    const options: NotebookExportOptions = {
      includeKnowledge: validatedBody.includeKnowledge ?? true,
      includeArtifacts: validatedBody.includeArtifacts ?? true,
      includeTools: validatedBody.includeTools ?? true,
      includeAgents: validatedBody.includeAgents ?? true,
      anonymize: validatedBody.anonymize ?? false,
      includeMetadata: validatedBody.includeMetadata ?? true,
      includeImages: validatedBody.includeImages ?? true,
      maxFileSize: validatedBody.maxFileSize ?? 10 * 1024 * 1024,
      notebookIds: validatedBody.notebookIds,
      fromDate: validatedBody.fromDate,
      toDate: validatedBody.toDate,
    };

    const adapters = {
      sessionRepository,
      chatHistoryRepository: questRepository,
      knowledgeRepository: fabFileRepository,
      artifactRepository,
      toolRepository: {
        find: async (query: any) => {
          return await Tool.find(query);
        },
        findById: async (id: string) => {
          return await Tool.findById(id);
        },
      },
      agentRepository,
      fileStorageService: {
        getFileContent: async (filePath: string): Promise<string | null> => {
          try {
            const data = await getFilesStorage().getContentAsBuffer(filePath);
            return data.toString('utf-8');
          } catch (error) {
            req.logger.error('Failed to read file content', { filePath, error });
            return null;
          }
        },
        uploadFile: async (path: string, content: Buffer): Promise<void> => {
          await getFilesStorage().upload(content, path);
        },
        getSignedUrl: async (filePath: string, expiresIn: number = 3600): Promise<string | null> => {
          try {
            return await getFilesStorage().getSignedUrl(filePath, 'get', { expiresIn });
          } catch (error) {
            req.logger.error('Failed to generate signed URL', { filePath, error });
            return null;
          }
        },
      },
      logger: req.logger || new Logger().withMetadata({ service: 'NotebookExportService', userId }),
    };

    try {
      const exportService = new NotebookExportService(adapters);

      // service handles file generation and upload internally
      const exportResult = await exportService.exportNotebooks(userId, options);

      return res.status(200).json({
        success: true,
        data: {
          downloadUrl: exportResult.downloadUrl,
          fileSize: exportResult.fileSize,
          notebookCount: exportResult.notebookCount,
          messageCount: exportResult.messageCount,
          attachmentCount: exportResult.attachmentCount,
          exportedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      // Status comes off the error, which is where the service already put it. Answering 500 for
      // everything is what paged LiveOps for a caller condition, since a 5xx-level log line is what
      // trips the CloudWatch filter. Anything carrying 500 falls through and stays loud. No log
      // line here: the service already wrote one at warn, through this same req.logger.
      if (error instanceof NotebookExportError && error.statusCode < 500) {
        return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
      }

      req.logger.error('Notebook export failed', { userId, error });

      return res.status(500).json({
        success: false,
        message: 'Export failed. Please try again later.',
      });
    }
  })
);

export default handler;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
    externalResolver: true,
  },
};
