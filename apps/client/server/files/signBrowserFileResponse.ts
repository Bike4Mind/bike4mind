import type { IFabFileDocument } from '@bike4mind/common';
import { adminSettingsRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';

export async function signBrowserFileResponse(file: IFabFileDocument): Promise<IFabFileDocument> {
  const plainFile =
    typeof (file as { toJSON?: unknown }).toJSON === 'function'
      ? (file as unknown as { toJSON: () => IFabFileDocument }).toJSON()
      : file;
  if (!plainFile.fileUrl) return { ...plainFile };

  return fabFilesService.generateSignedUrl(plainFile, {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: {
      ...(process.env.S3_PRESIGN_ENDPOINT?.trim() && { signedUrlCache: 'bypass' as const }),
      generateSignedUrl: (path, expiresIn) =>
        getFilesStorage().getSignedUrl(path, 'get', { expiresIn, audience: 'browser' }),
    },
  });
}
