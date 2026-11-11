import type { IFabFileDocument } from '@bike4mind/common';
import { adminSettingsRepository, fabFileRepository, userRepository } from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { browserFileStorage } from '@server/files/browserFileSigner';

export async function signBrowserFileResponse(file: IFabFileDocument): Promise<IFabFileDocument> {
  const plainFile =
    typeof (file as { toJSON?: unknown }).toJSON === 'function'
      ? (file as unknown as { toJSON: () => IFabFileDocument }).toJSON()
      : file;
  return fabFilesService.generateSignedUrl(plainFile, {
    db: { fabFiles: fabFileRepository, users: userRepository, adminSettings: adminSettingsRepository },
    storage: browserFileStorage(),
  });
}
