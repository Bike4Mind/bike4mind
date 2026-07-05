import { Logger } from '@bike4mind/observability';
import { IFabFileDocument, IFabFileRepository, IUserDocument, isImageServeable } from '@bike4mind/common';
import { BadRequestError, NotFoundError, secureParameters } from '@bike4mind/utils';
import mime from 'mime-types';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';

const applyEditSchema = z.object({
  id: z.string(),
  modifiedContent: z.string(),
  createBackup: z.boolean().optional().prefault(true),
});

type ApplyEditParameters = z.infer<typeof applyEditSchema>;

const EXPIRE_IN_SECONDS = 3600;

interface ApplyEditAdapters {
  db: {
    fabFiles: Pick<IFabFileRepository, 'shareable' | 'update' | 'create'>;
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

export interface ApplyEditResult {
  success: boolean;
  fileId: string;
  fileName: string;
  backupId?: string;
  updatedAt: Date;
}

/**
 * Apply an edit to a FabFile, optionally creating a backup
 */
export const applyEdit = async (
  user: IUserDocument,
  parameters: ApplyEditParameters,
  { db, storage }: ApplyEditAdapters
): Promise<ApplyEditResult> => {
  const { id, modifiedContent, createBackup } = secureParameters(parameters, applyEditSchema);

  const fabFile = await db.fabFiles.shareable.findAccessibleById(user, id);
  if (!fabFile) throw new NotFoundError('File not found or access denied');

  // This service function has no live caller today (the gated route at
  // pages/api/fabfiles/[id]/apply-edit.ts reimplements its own logic), but it is
  // exported from the fabFileService barrel, so a future/internal caller could still
  // reach it. Refuse to read or overwrite a held/blocked uploaded image's bytes.
  if (!isImageServeable(fabFile)) throw new BadRequestError('File is not available for editing');

  let backupId: string | undefined;

  // Create a backup if requested
  if (createBackup && fabFile.fileUrl) {
    let currentContent = '';
    try {
      const response = await fetch(fabFile.fileUrl);
      if (response.ok) {
        currentContent = await response.text();
      }
    } catch (error) {
      Logger.globalInstance.warn('Could not fetch current content for backup:', error);
    }

    if (currentContent) {
      const backupFile: Partial<IFabFileDocument> = {
        fileName: `${fabFile.fileName}.backup-${new Date().toISOString()}`,
        mimeType: fabFile.mimeType,
        fileSize: currentContent.length,
        type: fabFile.type,
        userId: user.id,
        organizationId: fabFile.organizationId,
        sessionId: fabFile.sessionId,
        system: false,
        notes: `Backup of ${fabFile.fileName} before edit`,
        tags: [
          { name: 'backup', strength: 1 },
          { name: 'auto-generated', strength: 1 },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const ext = mime.extension(fabFile.mimeType) || 'txt';
      const backupPath = `${uuidv4()}.${ext}`;

      await storage.upload(backupPath, currentContent, {
        ContentType: fabFile.mimeType,
      });

      backupFile.filePath = backupPath;
      backupFile.fileUrl = await storage.generateSignedUrl(backupPath, EXPIRE_IN_SECONDS);
      backupFile.fileUrlExpireAt = new Date(Date.now() + EXPIRE_IN_SECONDS * 1000);

      const createdBackup = await db.fabFiles.create(backupFile as IFabFileDocument);
      backupId = createdBackup.id;
    }
  }

  const ext = mime.extension(fabFile.mimeType) || 'txt';
  const filePath = fabFile.filePath || `${uuidv4()}.${ext}`;

  await storage.upload(filePath, modifiedContent, {
    ContentType: fabFile.mimeType,
  });

  // Get actual file size from storage after upload
  let fileSize = modifiedContent.length; // Default to content length
  if (storage.getMetadata) {
    try {
      const metadata = await storage.getMetadata(filePath);
      if (metadata.size !== undefined) {
        fileSize = metadata.size;
      }
    } catch (error) {
      Logger.globalInstance.warn('Failed to retrieve file metadata from storage:', error);
    }
  }

  const updatedFabFile: Partial<IFabFileDocument> = {
    ...fabFile,
    filePath,
    fileSize,
    fileUrl: await storage.generateSignedUrl(filePath, EXPIRE_IN_SECONDS),
    fileUrlExpireAt: new Date(Date.now() + EXPIRE_IN_SECONDS * 1000),
    updatedAt: new Date(),
  };

  await db.fabFiles.update(updatedFabFile);

  return {
    success: true,
    fileId: fabFile.id,
    fileName: fabFile.fileName,
    backupId,
    updatedAt: updatedFabFile.updatedAt!,
  };
};
