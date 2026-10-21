import { isImageServeable } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import type { SignOutputUrl, StoredOutputRef } from './signedOutput';

// Only these statuses can still turn 'clean'; 'blocked' (or a missing status) never will.
const isAwaitingScan = (status: string | null | undefined): boolean => status === 'pending' || status === 'scanning';

// Must match where each job handler's store step put the bytes (e.g. VideoJobOutput.location).
// A Files copy is created 'pending' and only cleared by the async S3 objectCreated scan, so a job can read as
// succeeded before its file is serveable: sign it only once the FabFile passes the shared moderation gate.
// 'generated' output has no FabFile to gate (the Files save failed), so it is served like a generated image.
/**
 * The bytes of a serveable output, behind the same moderation gate as signOutputUrl. Throws when the output is not
 * serveable (still awaiting its scan, blocked, deleted); callers that need to tell those apart check signOutputUrl.
 */
export const downloadServeableOutput = async ({ location, s3Key, fileId }: StoredOutputRef): Promise<Buffer> => {
  if (location === 'generated') return getGeneratedImageStorage().download(s3Key);
  if (!fileId || !isValidObjectId(fileId)) throw new Error('generation output has no usable file id');
  const fabFile = await fabFileRepository.findById(fileId);
  if (!fabFile || fabFile.deletedAt || !isImageServeable(fabFile))
    throw new Error('generation output is not serveable');
  return getFilesStorage().download(s3Key);
};

export const signOutputUrl: SignOutputUrl = async ({ location, s3Key, fileId }, expiresIn) => {
  if (location === 'generated') {
    return { availability: 'ready', url: await getGeneratedImageStorage().getSignedUrl(s3Key, 'get', { expiresIn }) };
  }
  if (!fileId || !isValidObjectId(fileId)) return { availability: 'unavailable' };
  const fabFile = await fabFileRepository.findById(fileId);
  if (!fabFile || fabFile.deletedAt) return { availability: 'unavailable' };
  if (isImageServeable(fabFile)) {
    return { availability: 'ready', url: await getFilesStorage().getSignedUrl(s3Key, 'get', { expiresIn }) };
  }
  return isAwaitingScan(fabFile.moderationStatus) ? { availability: 'pending_scan' } : { availability: 'unavailable' };
};
