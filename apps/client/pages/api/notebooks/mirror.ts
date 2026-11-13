import { notebookExportService } from '@bike4mind/services';
import {
  sessionRepository,
  questRepository,
  fabFileRepository,
  artifactRepository,
  artifactContentRepository,
  agentRepository,
  Tool,
} from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { AttachmentLakeAccess } from '@bike4mind/common';
import { z } from 'zod';

const { NotebookExportService } = notebookExportService;
type ExportOptions = Parameters<typeof NotebookExportService.prototype.exportNotebooks>[1];
type ExportAdapters = ConstructorParameters<typeof NotebookExportService>[0];

const MirrorRequestSchema = z.object({
  /** Opaque token from the previous page; omit to bootstrap from the start. */
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(25).prefault(10),
});

const MIRROR_OPTIONS: ExportOptions = {
  includeKnowledge: true,
  includeArtifacts: true,
  includeTools: true,
  includeAgents: true,
  anonymize: false,
  includeMetadata: true,
  includeImages: true,
  maxFileSize: 10 * 1024 * 1024,
};

/**
 * Pull side of the continuous mirror: returns the next page of notebooks changed since `cursor`,
 * hash-chained so the caller can verify what it applied. The caller owns the state and the
 * destination, so nothing about the destination is stored here.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ success: false, message: 'User not authenticated' });

    const parsed = MirrorRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body',
        errors: parsed.error.issues.map(i => ({ field: i.path.join('.'), message: i.message })),
      });
    }

    let lakeAccess: Promise<AttachmentLakeAccess> | undefined;
    const adapters = {
      sessionRepository,
      chatHistoryRepository: questRepository,
      knowledgeRepository: fabFileRepository,
      knowledgeAccess: {
        userGroups: req.user.groups ?? undefined,
        resolveLakeAccess: () =>
          (lakeAccess ??= import('@server/dataLakes/attachmentLakeAccess').then(m =>
            m.createAttachmentLakeAccess(req.user, req.logger)()
          )),
      },
      artifactRepository,
      artifactContentRepository,
      toolRepository: {
        find: (query: Record<string, unknown>) => Tool.find(query),
        findById: (id: string) => Tool.findById(id),
      },
      agentRepository,
      fileStorageService: {
        getFileContent: async (filePath: string): Promise<Buffer | null> => {
          try {
            return await getFilesStorage().getContentAsBuffer(filePath);
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
      logger: req.logger,
    } as unknown as ExportAdapters;

    try {
      const page = await new NotebookExportService(adapters).getMirrorPage(
        userId,
        MIRROR_OPTIONS,
        parsed.data.cursor,
        parsed.data.limit
      );
      return res.status(200).json({ success: true, data: page });
    } catch (error) {
      if (error instanceof Error && error.message === 'Invalid mirror cursor') {
        return res.status(400).json({ success: false, message: error.message });
      }
      req.logger.error('Notebook mirror page failed', { userId, error });
      return res.status(500).json({ success: false, message: 'Mirror failed. Please try again later.' });
    }
  })
);

export default handler;

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' }, externalResolver: true },
};
