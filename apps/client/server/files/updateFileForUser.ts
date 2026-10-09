import { FileEvents } from '@bike4mind/common';
import {
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  scopedSettingsRepository,
  withTransaction,
} from '@bike4mind/database';
import { fabFilesService } from '@bike4mind/services';
import { logEventSafe } from '@server/utils/analyticsLog';
import { getFilesStorage } from '@server/utils/storage';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { assertDataLakeWriteScope } from '@server/dataLakes/dataLakeScopes';
import type { Request } from 'express';

type UpdateFabFileParams = Parameters<typeof fabFilesService.updateFabFile>[1];
type LakeTagParams = Pick<UpdateFabFileParams, 'tags' | 'primaryTag'>;

/**
 * Updates a FabFile the caller may edit and emits the UPDATE_FILE analytics event. Throws
 * NotFoundError when the caller lacks update access. Any route-level lake-tag gate is the caller's
 * job: this runs only the gates inside `updateFabFile`. That is why tags travel in their own
 * `gatedLakeTags` argument, which a caller passes only after running PUT /api/files/{id}'s prologue gate.
 *
 * Shared by the SPA-internal PUT /api/files/{id} and the public PATCH /api/v1/files/{id}, so the two
 * doors cannot drift apart.
 */
export async function updateFileForUser(
  req: Request,
  administeredOrgIds: string[] | undefined,
  params: Omit<UpdateFabFileParams, keyof LakeTagParams>,
  gatedLakeTags?: LakeTagParams
) {
  const updated = await withTransaction(async () => {
    try {
      return await fabFilesService.updateFabFile(
        req.user,
        { ...params, ...gatedLakeTags },
        {
          db: {
            fabFiles: fabFileRepository,
            dataLakes: dataLakeRepository,
            dataLakeAccessGrants: dataLakeAccessGrantRepository,
            // `lakeConfigAuditDb` carries `adminSettings`, which is also what the admission
            // contract's lever resolves from; only `scopedSettings` is additional here.
            ...lakeConfigAuditDb,
            ...lakeMembershipAuditDb,
            scopedSettings: scopedSettingsRepository,
          },
          // `reconcileLakeTags` re-gates every lake this write JOINS, so its actor has to stay as
          // wide as PUT /api/files/{id}'s prologue gate - the org rungs of `canManageLake` cannot be
          // derived from the user document this service is handed.
          administeredOrgIds,
          // Same reason deleteFileForUser attaches one: a tag write here can flip a draft lake to
          // active, and both doors accept a `b4m_live_` key.
          auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo),
          // Covers the fileTagPrefix membership arm the route-level gate cannot see (it has no
          // resolved file owner) - called only when reconcileLakeTags actually finds a prefix-arm
          // join. Mirrors the toggle route's identical gate.
          assertWriteScope: () => assertDataLakeWriteScope(req),
          logger: req.logger,
          storage: {
            upload: (filepath, content, option) => getFilesStorage().upload(content, filepath, option),
            generateSignedUrl: (path: string, expireInSeconds: number) =>
              getFilesStorage().getSignedUrl(path, undefined, { expiresIn: expireInSeconds }),
          },
        }
      );
    } catch (error) {
      req.logger.error('Error updating fab file:', { error, fileId: params.id });
      throw error;
    }
  });

  // After the commit, so an analytics failure cannot turn a saved edit into a 500.
  await logEventSafe(
    {
      userId: req.user.id,
      type: FileEvents.UPDATE_FILE,
      metadata: { fileId: params.id, fileContent: updated.filePath ?? '' },
    },
    { ability: req.ability },
    req.logger
  );

  return updated;
}
