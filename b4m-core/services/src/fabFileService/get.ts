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
// Re-sign a little before expiry so a client is not handed a URL about to lapse mid-render.
// Shared with projectService/listFiles so both cache readers apply the same rule.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export const hasUsableCachedUrl = ({
  fileUrl,
  fileUrlExpireAt,
}: Pick<IFabFileDocument, 'fileUrl' | 'fileUrlExpireAt'>) =>
  Boolean(fileUrl && fileUrlExpireAt && new Date(fileUrlExpireAt).getTime() - REFRESH_MARGIN_MS > Date.now());

const AMZ_DATE_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
// The signer can only clamp to a credential expiration it is told about; some runtimes'
// credentials report none. Never trust a cached link longer than this so a dead one self-heals.
const MAX_CACHED_URL_SECONDS = 3600;

/**
 * When to stop serving a freshly signed URL from the FabFile cache. An S3 signer may shorten the
 * requested lifetime to that of its credentials (S3Storage.getSignedUrl), so read it from the
 * SigV4 query (X-Amz-Date + X-Amz-Expires); a URL without them (non-S3 adapter) gets the requested
 * lifetime. Either way the result is capped at MAX_CACHED_URL_SECONDS from now.
 */
export const signedUrlExpiresAt = (fileUrl: string, requestedSeconds: number): Date => {
  const fallback = new Date(Date.now() + Math.min(requestedSeconds, MAX_CACHED_URL_SECONDS) * 1000);
  let params: URLSearchParams;
  try {
    params = new URL(fileUrl).searchParams;
  } catch {
    return fallback;
  }
  const date = AMZ_DATE_PATTERN.exec(params.get('X-Amz-Date') ?? '');
  const expires = Number(params.get('X-Amz-Expires'));
  if (!date || !Number.isFinite(expires) || expires <= 0) return fallback;
  const [, year, month, day, hour, minute, second] = date.map(Number);
  const signedAt = Date.UTC(year, month - 1, day, hour, minute, second);
  return new Date(Math.min(signedAt + expires * 1000, fallback.getTime()));
};

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
    // Response-only signing must not reuse or overwrite the shared server URL cache.
    signedUrlCache?: 'bypass';
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

export const generateSignedUrl = async (fabFileIn: IFabFileDocument, { db, storage }: GetFabFileAdapter) => {
  // Curator ruling metadata (who ruled, when, which lake) is `select: false` on the schema (see
  // FabFileModel.ts), so it is normally already absent here. This strip is a second, defensive
  // layer for a caller that explicitly opted back in upstream (the curator-supersession collapse's
  // own reads) and then handed the same document down this path - it must never reach a response
  // body. A shallow copy, not a mutation: this is the one function every outward-facing file read
  // (get/list/search, byIds, the shared-lake fallback) passes a FabFile through, and some of those
  // callers still hold and use their own reference to the same object afterward.
  const fabFile = { ...fabFileIn, supersededInLakes: undefined };

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

  const bypassCache = storage.signedUrlCache === 'bypass';
  if (bypassCache) {
    fabFile.fileUrl = undefined;
    fabFile.fileUrlExpireAt = undefined;
  }

  // Trust the stored expiry rather than probing the URL: a GET probe downloaded the object on
  // every read and leaked an unhandled `TypeError: terminated` when S3 closed the unread body.
  if (hasUsableCachedUrl(fabFile)) return fabFile;

  if (!fabFile.filePath) return fabFile;

  // Generate a new signed URL since existing one is invalid or expired
  const fileUrl = await storage.generateSignedUrl(fabFile.filePath, EXPIRE_IN_SECONDS);
  if (!fileUrl) return fabFile; // Avoid updating if URL generation fails

  const fileUrlExpireAt = signedUrlExpiresAt(fileUrl, EXPIRE_IN_SECONDS);
  fabFile.fileUrl = fileUrl;
  fabFile.fileUrlExpireAt = fileUrlExpireAt;

  // Read-triggered cache refresh: persist ONLY the regenerated URL fields. A
  // whole-document write here (this GET is reachable by a sharee) would revert an
  // owner's concurrent revocation, soft-delete or visibility change.
  if (!bypassCache) {
    await db.fabFiles.update({ id: fabFile.id, fileUrl, fileUrlExpireAt }, { timestamps: false });
  }

  return fabFile;
};
