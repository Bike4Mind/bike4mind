import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { type ArchiveStorage } from './legacyQuestPlanConversion';

/** The files bucket, adapted to what the legacy quest plan conversion writes through. */
export const filesArchiveStorage = (): ArchiveStorage => {
  const files = getFilesStorage();
  return {
    upload: (path, content, options) =>
      files.upload(content ?? '', path, {
        ContentType: options?.ContentType || 'text/markdown',
        ContentLength: options?.ContentLength ?? Buffer.byteLength(content ?? '', 'utf8'),
      }),
    generateSignedUrl: (path, expiresIn, type) => files.getSignedUrl(path, type ?? 'get', { expiresIn }),
    overwrite: async (path, content, options) => {
      await files.upload(content, path, options);
    },
  };
};
