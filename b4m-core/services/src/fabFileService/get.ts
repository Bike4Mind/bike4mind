import { Logger } from '@bike4mind/observability';
import {
  IFabFileDocument,
  IFabFileRepository,
  IUserRepository,
  IAdminSettingsRepository,
  isImageServeable,
} from '@bike4mind/common';
import {
  NotFoundError,
  secureParameters,
  getSettingByName,
  signedUrlExpiresAt,
  fileUrlSigningDate,
  FILE_URL_TTL_SECONDS,
} from '@bike4mind/utils';
import { z } from 'zod';

// Re-exported for the services that stamp `fileUrlExpireAt` on a response.
export { signedUrlExpiresAt };

const getFabFileSchema = z.object({
  id: z.string(),
});

type GetFabFileParameters = z.infer<typeof getFabFileSchema>;

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
    generateSignedUrl: (
      path: string,
      expireInSeconds: number,
      options?: { signingDate?: Date }
    ) => Promise<string | null>;
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

export const generateSignedUrl = async (
  fabFileIn: IFabFileDocument,
  { storage }: Pick<GetFabFileAdapter, 'storage'> & Partial<GetFabFileAdapter>
) => {
  // Curator ruling metadata (who ruled, when, which lake) is `select: false` on the schema (see
  // FabFileModel.ts), so it is normally already absent here. This strip is a second, defensive
  // layer for a caller that explicitly opted back in upstream (the curator-supersession collapse's
  // own reads) and then handed the same document down this path - it must never reach a response
  // body. A shallow copy, not a mutation: this is the one function every outward-facing file read
  // (get/list/search, byIds, the shared-lake fallback) passes a FabFile through, and some of those
  // callers still hold and use their own reference to the same object afterward.
  // list/byIds hand over hydrated docs, whose spread copies only _doc/$__ and drops every field.
  const plain =
    typeof (fabFileIn as { toJSON?: unknown }).toJSON === 'function'
      ? (fabFileIn as unknown as { toJSON: () => IFabFileDocument }).toJSON()
      : fabFileIn;
  const fabFile = { ...plain, supersededInLakes: undefined };

  // Never hand out a URL for an image that's still held (pending scan) or was
  // quarantined (blocked) by upload moderation, before any URL work. We withhold the
  // URL but return the record (with moderationStatus/fileName/id intact) so the client can
  // render a "Scanning..."/blocked placeholder instead of the file silently vanishing from
  // listings and the message stream. No bytes are serveable without a URL.
  if (!isImageServeable(fabFile)) {
    fabFile.fileUrl = undefined;
    fabFile.fileUrlExpireAt = undefined;
    fabFile.presignedUrl = undefined;
    return fabFile;
  }

  // Signed URLs are response-only: never trust a stored one, a legacy row may still carry it.
  fabFile.fileUrl = undefined;
  fabFile.fileUrlExpireAt = undefined;
  fabFile.presignedUrl = undefined;

  if (!fabFile.filePath) return fabFile;

  const fileUrl = await storage.generateSignedUrl(fabFile.filePath, FILE_URL_TTL_SECONDS, {
    signingDate: fileUrlSigningDate(),
  });
  if (!fileUrl) return fabFile;

  fabFile.fileUrl = fileUrl;
  fabFile.fileUrlExpireAt = signedUrlExpiresAt(fileUrl, FILE_URL_TTL_SECONDS);

  return fabFile;
};
