import type { Request } from 'express';
import type { AccessContext, IDataLakeDocument } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  lakeMembershipRemovalRepository,
  scopedSettingsRepository,
  withTransaction,
} from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { lakeConfigAuditDb } from '@bike4mind/server-utils/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@bike4mind/server-utils/dataLakes/lakeMembershipAuditDb';
import { storageOwnerTransferDb } from '@bike4mind/server-utils/files/storageOwnerTransferDb';

/**
 * The public membership-write path shared by /api/v1/data-lakes/{id}/files/{file_id} and the obligation
 * confirm (pages/api/v1/obligations/[id].ts), so filing a document cannot authorize differently.
 */

export const lakeAccessDb = {
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  settings: adminSettingsRepository,
};

/**
 * The membership-write gate: readable (404 otherwise), then manageable and not built-in (403).
 * Decided here from the manage rule itself rather than by matching the service's refusal text.
 */
export async function assertLakeMembershipWritable(
  lakeIdOrSlug: string,
  ctx: AccessContext,
  logger: Request['logger']
): Promise<IDataLakeDocument> {
  const { lake, grants } = await dataLakeService.assertLakeAccessWithGrants(lakeIdOrSlug, ctx, {
    db: lakeAccessDb,
    logger,
  });
  if (dataLakeService.isFallbackLake(lake)) {
    throw new ForbiddenError('This data lake is built into the platform and is read-only');
  }
  if (!dataLakeService.canManageLake(lake, ctx, grants)) {
    throw new ForbiddenError('You do not have permission to change which files belong to this data lake');
  }
  return lake;
}

export const membershipWriteDb = {
  ...storageOwnerTransferDb,
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  fabFiles: fabFileRepository,
  lakeMembershipRemovals: lakeMembershipRemovalRepository,
  // Without these the draft -> active flip a membership change can trigger records nothing; see
  // the SPA route (pages/api/data-lakes/[id]/files/[fabFileId].ts).
  ...lakeConfigAuditDb,
  ...lakeMembershipAuditDb,
};

type MembershipActor = Parameters<typeof dataLakeService.addFileToDataLake>[0];

/**
 * Gates the lake, then adds the file, in one transaction. `resolveFileId` runs after the gate so the
 * lake's 404/403 wins over a bad file id. `alsoInTransaction` commits or rolls back with the membership.
 */
export async function addFileToWritableLake<T = undefined>(opts: {
  lakeIdOrSlug: string;
  ctx: AccessContext;
  actor: MembershipActor;
  resolveFileId: () => string;
  logger: Request['logger'];
  alsoInTransaction?: (lake: IDataLakeDocument) => Promise<T>;
}) {
  return withTransaction(async () => {
    const lake = await assertLakeMembershipWritable(opts.lakeIdOrSlug, opts.ctx, opts.logger);
    const fileId = opts.resolveFileId();
    const result = await dataLakeService.addFileToDataLake(opts.actor, lake.id, fileId, {
      db: { ...membershipWriteDb, scopedSettings: scopedSettingsRepository },
      logger: opts.logger,
    });
    // Serializes this write against a concurrent grant revoke - see WRITE-TIME RESIDUAL on `canManageLake`.
    await dataLakeRepository.touchIfStable(lake.id);
    const extra = opts.alsoInTransaction ? await opts.alsoInTransaction(lake) : undefined;
    return { lake, fileId, result, extra };
  });
}
