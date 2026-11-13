import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  organizationRepository,
  scopedSettingsRepository,
  sessionRepository,
  OrganizationGeneratedObject,
  User,
} from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { saveGeneratedAsset, type SaveGeneratedAssetParams, type SaveGeneratedAssetResult } from '@bike4mind/services';
import { getFilesStorage } from './storage/index';

/** saveGeneratedAsset wired to the FabFile bucket and repositories, for server routes and job handlers. */
export async function saveGeneratedAssetToFiles(
  params: SaveGeneratedAssetParams,
  logger: Pick<Logger, 'info' | 'warn' | 'error'>
): Promise<SaveGeneratedAssetResult> {
  const { contentType, signal } = params;
  const session = params.sessionId ? await sessionRepository.findByIdAndUserId(params.sessionId, params.userId) : null;
  const ownerOrganizationId = session?.retentionOrganizationId;
  const key = params.generatedCopyKey ?? params.generatedOutputKey;
  if (ownerOrganizationId && key) {
    await OrganizationGeneratedObject.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          organizationId: ownerOrganizationId,
          userId: params.userId,
          sessionId: session.id,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }
  return saveGeneratedAsset(params, {
    ownerOrganizationId,
    db: {
      fabFiles: fabFileRepository,
      adminSettings: adminSettingsRepository,
      // Absent, the admission lever (#1680) resolves platform-only, so a per-org/owner/lake enforcement
      // override would silently not apply on this door.
      scopedSettings: scopedSettingsRepository,
      users: User,
      organizations: organizationRepository,
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
