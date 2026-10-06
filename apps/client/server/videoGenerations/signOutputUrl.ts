import { isImageServeable } from '@bike4mind/common';
import { fabFileRepository } from '@bike4mind/database';
import { isValidObjectId } from '@server/utils/objectId';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import type { SignOutputUrl } from './toPublicVideoGeneration';

// Must match where videoJobHandler's store step put the bytes (VideoJobOutput.location).
// A Files copy is created 'pending' and only cleared by the async S3 objectCreated scan, so a job can read as
// succeeded before its file is serveable: sign it only once the FabFile passes the shared moderation gate.
export const signOutputUrl: SignOutputUrl = async ({ location, s3Key, fileId }, expiresIn) => {
  if (location === 'generated') return getGeneratedImageStorage().getSignedUrl(s3Key, 'get', { expiresIn });
  if (!fileId || !isValidObjectId(fileId)) return null;
  const fabFile = await fabFileRepository.findById(fileId);
  if (!fabFile || fabFile.deletedAt || !isImageServeable(fabFile)) return null;
  return getFilesStorage().getSignedUrl(s3Key, 'get', { expiresIn });
};
