import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import type { SignOutputUrl } from './toPublicVideoGeneration';

// Must match where videoJobHandler's store step put the bytes (VideoJobOutput.location).
export const signOutputUrl: SignOutputUrl = (location, s3Key, expiresIn) =>
  (location === 'files' ? getFilesStorage() : getGeneratedImageStorage()).getSignedUrl(s3Key, 'get', { expiresIn });
