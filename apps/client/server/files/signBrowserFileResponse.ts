import type { IFabFileDocument } from '@bike4mind/common';
import { adminSettingsRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';

export async function signBrowserFileResponse(file: IFabFileDocument): Promise<IFabFileDocument> {
  if (!file.fileUrl) return { ...file };

  return fabFilesService.generateSignedUrl(file, {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: {
      signedUrlCache: 'bypass',
      generateSignedUrl: (path, expiresIn) =>
        getFilesStorage().getSignedUrl(path, 'get', { expiresIn, audience: 'browser' }),
    },
  });
}
