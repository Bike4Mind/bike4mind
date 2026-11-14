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
import { orgAclRowConfersMembership } from '@bike4mind/common';
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
  const organization = session?.retentionOrganizationId
    ? await organizationRepository.findById(session.retentionOrganizationId)
    : null;
  const retentionOrganizationId =
    organization &&
    !organization.personal &&
    (organization.userId === params.userId ||
      organization.users.some(row => row.userId === params.userId && orgAclRowConfersMembership(row)))
      ? organization.id
      : undefined;
  const key = params.generatedCopyKey ?? params.generatedOutputKey;
  const result = await saveGeneratedAsset(params, {
    retentionOrganizationId,
    db: {
      fabFiles: fabFileRepository,
      adminSettings: adminSettingsRepository,
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
  if (retentionOrganizationId && key && session) {
    await OrganizationGeneratedObject.updateOne(
      { key },
      {
        $setOnInsert: {
          key,
          organizationId: retentionOrganizationId,
          userId: params.userId,
          sessionId: session.id,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }
  return result;
}
