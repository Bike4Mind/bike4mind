import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  scopedSettingsRepository,
  User,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { saveGeneratedAsset, type SaveGeneratedAssetParams, type SaveGeneratedAssetResult } from '@bike4mind/services';
import { getFilesStorage } from '@server/utils/storage';

/** saveGeneratedAsset wired to the FabFile bucket and repositories, for server routes and job handlers. */
export function saveGeneratedAssetToFiles(
  params: SaveGeneratedAssetParams,
  logger: Pick<Logger, 'info' | 'error'>
): Promise<SaveGeneratedAssetResult> {
  const { contentType, signal } = params;
  return saveGeneratedAsset(params, {
    db: {
      fabFiles: fabFileRepository,
      adminSettings: adminSettingsRepository,
      // Absent, the admission lever (#1680) resolves platform-only, so a per-org/owner/lake enforcement
      // override would silently not apply on this door.
      scopedSettings: scopedSettingsRepository,
      users: User,
      dataLakes: dataLakeRepository,
    },
    storage: {
      upload: (path, content, options) =>
        getFilesStorage().upload(content, path, { ContentType: options?.ContentType || contentType }, signal),
      generateSignedUrl: (path, expireInSeconds, type) =>
        getFilesStorage().getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
    },
    logger,
  });
}
