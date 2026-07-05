import { Logger } from '@bike4mind/observability';
import {
  IFabFileDocument,
  IFabFileRepository,
  IUserRepository,
  IAdminSettingsRepository,
  isImageServeable,
} from '@bike4mind/common';
import { NotFoundError, secureParameters, getSettingByName } from '@bike4mind/utils';
import { z } from 'zod';

const getFabFileSchema = z.object({
  id: z.string(),
});

type GetFabFileParameters = z.infer<typeof getFabFileSchema>;

const EXPIRE_IN_SECONDS = 3600;

/**
 * Check if a file ID is listed in the global SystemFiles admin setting
 */
const checkIfGlobalSystemPrompt = async (
  fileId: string,
  db: { adminSettings: IAdminSettingsRepository }
): Promise<boolean> => {
  try {
    const systemFilesValue = await getSettingByName('SystemFiles', db);
    if (!systemFilesValue) return false;

    // SystemFiles is stored as a comma-separated string of file IDs
    const globalSystemFileIds = systemFilesValue
      .split(',')
      .map(id => id.trim())
      .filter(Boolean);

    return globalSystemFileIds.includes(fileId);
  } catch (error) {
    // If we can't check the setting, default to normal access control
    Logger.globalInstance.error('Error checking SystemFiles setting:', error);
    return false;
  }
};

export interface GetFabFileAdapter {
  db: {
    fabFiles: IFabFileRepository;
    users: IUserRepository;
    adminSettings: IAdminSettingsRepository;
  };
  storage: {
    generateSignedUrl: (path: string, expireInSeconds: number) => Promise<string | null>;
  };
}

export const getFabFile = async (
  userId: string,
  parameters: GetFabFileParameters,
  { db, storage }: GetFabFileAdapter
) => {
  const { id } = secureParameters(parameters, getFabFileSchema);

  const user = await db.users.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  const isGlobalSystemPrompt = await checkIfGlobalSystemPrompt(id, db);

  let fabFile: IFabFileDocument | null;

  if (isGlobalSystemPrompt) {
    // For global system prompts, allow access regardless of ownership
    fabFile = await db.fabFiles.findById(id);
  } else {
    // For regular files, use normal access control
    fabFile = await db.fabFiles.shareable.findAccessibleById(user, id);
  }

  if (!fabFile) throw new NotFoundError('Fabfile not found');

  return generateSignedUrl(fabFile, { db, storage });
};

export const generateSignedUrl = async (fabFile: IFabFileDocument, { db, storage }: GetFabFileAdapter) => {
  // Never hand out a URL for an image that's still held (pending scan) or was
  // quarantined (blocked) by upload moderation, before any URL work. We withhold the
  // URL but return the record (with moderationStatus/fileName/id intact) so the client can
  // render a "Scanning..."/blocked placeholder instead of the file silently vanishing from
  // listings and the message stream. No bytes are serveable without a URL.
  if (!isImageServeable(fabFile)) {
    fabFile.fileUrl = undefined;
    fabFile.fileUrlExpireAt = undefined;
    return fabFile;
  }

  // True if the current URL is invalid (fetch throws or returns non-OK).
  const shouldGenerateNewUrl = async (url: string): Promise<boolean> => {
    try {
      const response = await fetch(url, { method: 'GET' });
      return !response.ok;
    } catch (error) {
      return true;
    }
  };

  // Skip generating a new URL if current URL is valid and not expired
  if (fabFile.fileUrl && fabFile.fileUrlExpireAt && fabFile.fileUrlExpireAt > new Date()) {
    const errorInUrl = await shouldGenerateNewUrl(fabFile.fileUrl);
    if (!errorInUrl) {
      return fabFile;
    }
  }

  if (!fabFile.filePath) return fabFile;

  // Generate a new signed URL since existing one is invalid or expired
  const fileUrl = await storage.generateSignedUrl(fabFile.filePath, EXPIRE_IN_SECONDS);
  if (!fileUrl) return fabFile; // Avoid updating if URL generation fails

  const fileUrlExpireAt = new Date(Date.now() + 1000 * EXPIRE_IN_SECONDS);
  fabFile.fileUrl = fileUrl;
  fabFile.fileUrlExpireAt = fileUrlExpireAt;

  await db.fabFiles.update(fabFile, { timestamps: false });

  return fabFile;
};
