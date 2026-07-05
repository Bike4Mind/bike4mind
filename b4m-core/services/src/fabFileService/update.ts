import { Logger } from '@bike4mind/observability';
import {
  IFabFileDocument,
  IFabFileRepository,
  IUserDocument,
  KnowledgeType,
  isImageServeable,
} from '@bike4mind/common';
import { NotFoundError, secureParameters } from '@bike4mind/utils';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';

import { z } from 'zod';

const updateFabFileSchema = z.object({
  id: z.string(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  fileContent: z.string().optional(),
  type: z.enum(KnowledgeType).optional(),
  system: z.boolean().optional(),
  systemPriority: z.number().min(0).max(999).optional(),
  sessionId: z.string().optional(),
  notes: z.string().optional(),
  primaryTag: z.string().nullable().optional(),
  tags: z
    .array(
      z.object({
        name: z.string(),
        strength: z.number(),
      })
    )
    .optional(),
  error: z.string().nullable().optional(),
});

const EXPIRE_IN_SECONDS = 3600;

type UpdateFabFileParameters = z.infer<typeof updateFabFileSchema>;

interface UpdateFabFileAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update'>;
  };
  storage: {
    upload: (filePath: string, content: string, metadata?: Record<string, unknown>) => Promise<unknown>;
    generateSignedUrl: (path: string, expireInSeconds: number) => Promise<string>;
    getMetadata?: (path: string) => Promise<{
      size?: number;
      contentType?: string;
      lastModified?: Date;
      etag?: string;
    }>;
  };
}

export const updateFabFile = async (
  user: IUserDocument,
  parameters: UpdateFabFileParameters,
  { db, storage }: UpdateFabFileAdapters
) => {
  const { id, fileContent, ...params } = secureParameters(parameters, updateFabFileSchema);

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, id);

  if (!fabFile) throw new NotFoundError('Invalid ID');

  if (fileContent !== undefined && !fabFile.mimeType.startsWith('image/')) {
    const mimeType = params.mimeType ?? fabFile.mimeType;
    const ext = mime.extension(mimeType) || null;
    const filePath = fabFile.filePath ?? `${uuidv4()}${ext ? `.${ext}` : '.txt'}`;

    await storage.upload(filePath, fileContent, {
      ContentType: mimeType,
    });

    // Get actual file size from S3 after upload
    if (storage.getMetadata) {
      try {
        const metadata = await storage.getMetadata(filePath);
        if (metadata.size !== undefined) {
          fabFile.fileSize = metadata.size;
        }
      } catch (error) {
        Logger.globalInstance.warn('Failed to retrieve file metadata from S3:', error);
      }
    }

    fabFile.fileUrl = await storage.generateSignedUrl(filePath, EXPIRE_IN_SECONDS);
    fabFile.fileUrlExpireAt = new Date(Date.now() + EXPIRE_IN_SECONDS * 1000);
  }

  const updatedFabFile: Partial<IFabFileDocument> = {
    ...fabFile,
    ...params,
    systemPriority: params.system && params.systemPriority === undefined ? 999 : params.systemPriority,
    updatedAt: new Date(),
  };

  // An edit (rename/tag/notes/etc.) must not echo back a working GET url for an image
  // that isn't clean (pending scan) or was quarantined (blocked) by upload moderation.
  // Mirrors the withhold-but-keep-metadata pattern in fabFileService/get.ts
  // generateSignedUrl so the client can still render a placeholder instead of the file
  // vanishing. MUST run BEFORE db.fabFiles.update() below - clearing after the write would
  // still persist the stale fileUrl (only the in-memory/returned object was cleared), so a
  // subsequent read would resurrect a working URL for a file that isn't serveable.
  if (!isImageServeable(updatedFabFile)) {
    updatedFabFile.fileUrl = undefined;
    updatedFabFile.fileUrlExpireAt = undefined;
  }

  await db.fabFiles.update(updatedFabFile);

  return updatedFabFile;
};
