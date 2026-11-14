import {
  adminSettingsRepository,
  dataLakeRepository,
  fabFileRepository,
  organizationRepository,
  scopedSettingsRepository,
  sessionRepository,
  recordRetainedGeneratedObject,
  lockRetentionCreator,
  withTransaction,
  User,
} from '@bike4mind/database';
import { orgAclRowConfersMembership } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { saveGeneratedAsset, type SaveGeneratedAssetParams, type SaveGeneratedAssetResult } from '@bike4mind/services';
import { getFilesStorage } from './storage/index';
import { rememberGeneratedFileCleanup, deleteRememberedGeneratedFile } from './generatedFileCleanup';

class ErasedGeneratedAssetCreatorError extends Error {}

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
  if (retentionOrganizationId && key && session) {
    const creatorLive = await recordRetainedGeneratedObject({
      key,
      organizationId: retentionOrganizationId,
      userId: params.userId,
      sessionId: session.id,
    });
    if (!creatorLive) return { saved: false, reason: 'error' };
  }
  const uploadedPaths = new Set<string>();
  const persist = () =>
    saveGeneratedAsset(params, {
      retentionOrganizationId,
      db: {
        fabFiles: {
          findOne: filter => fabFileRepository.findOne(filter),
          create: data =>
            withTransaction(async transaction => {
              if (!(await lockRetentionCreator(params.userId, transaction))) {
                throw new ErasedGeneratedAssetCreatorError('The generated asset creator is no longer active');
              }
              return fabFileRepository.create(data);
            }),
        },
        adminSettings: adminSettingsRepository,
        // Absent, the admission lever (#1680) resolves platform-only, so a per-org/owner/lake enforcement
        // override would silently not apply on this door.
        scopedSettings: scopedSettingsRepository,
        users: User,
        organizations: organizationRepository,
        dataLakes: dataLakeRepository,
      },
      storage: {
        upload: async (path, content, options) => {
          try {
            const uploaded = await getFilesStorage().upload(
              content,
              path,
              { ContentType: options?.ContentType || contentType },
              signal
            );
            uploadedPaths.add(path);
            return uploaded;
          } catch (error) {
            try {
              await rememberGeneratedFileCleanup(path, { ambiguousUpload: true });
            } catch (receiptError) {
              logger.error('Could not retain the generated upload cleanup receipt', { path, receiptError });
            }
            throw error;
          }
        },
        generateSignedUrl: (path, expireInSeconds, type) =>
          getFilesStorage().getSignedUrl(path, type ?? 'get', { expiresIn: expireInSeconds }),
      },
      logger,
    });
  const removeUploadedFiles = async () => {
    // These new Files keys were uploaded by this invocation; the org's inline key stays owned by its ledger.
    for (const path of uploadedPaths) {
      try {
        await rememberGeneratedFileCleanup(path);
      } catch (error) {
        // The exact object is ours even if its retry receipt cannot be stored.
        await getFilesStorage().deletePermanently(path);
        throw error;
      }
      await deleteRememberedGeneratedFile(path);
    }
  };
  let result: SaveGeneratedAssetResult;
  try {
    result = await persist();
  } catch (error) {
    if (error instanceof ErasedGeneratedAssetCreatorError) await removeUploadedFiles();
    throw error;
  }
  if (!result.saved && result.cause instanceof ErasedGeneratedAssetCreatorError) await removeUploadedFiles();
  return result;
}
