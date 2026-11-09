import type { IFabFileDocument } from '@bike4mind/common';
import { adminSettingsRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

export async function signBrowserFileResponse(file: IFabFileDocument): Promise<IFabFileDocument> {
  const plainFile =
    typeof (file as { toJSON?: unknown }).toJSON === 'function'
      ? (file as unknown as { toJSON: () => IFabFileDocument }).toJSON()
      : file;
  return fabFilesService.generateSignedUrl(plainFile, {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: {
      generateSignedUrl: (path, expiresIn, options) =>
        getFilesStorage().getSignedUrl(path, 'get', {
          expiresIn,
          audience: 'browser',
          signingDate: options?.signingDate,
        }),
    },
  });
}
