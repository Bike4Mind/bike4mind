/**
 * /api/v1/data-lakes/{id}/files/{file_id} - one lake member.
 *
 *   GET    - the member's ingestion status (`getDataLakeFileContract`)
 *   POST   - make the file a member (`addDataLakeFileContract`)
 *   DELETE - drop the membership (`removeDataLakeFileContract`)
 *
 * Public twins of GET /api/data-lakes/:id/articles (per-file) and POST/DELETE
 * /api/data-lakes/:id/files/:fabFileId, over the same services. Two things differ on purpose:
 * a caller who can read the lake but not manage it gets a 403 from an explicit manage pre-check
 * (the SPA door lets the service refuse it as a 400), and a malformed `file_id` is a 404 rather
 * than a CastError. The lake gate runs first, so its 404/403 wins over a malformed `file_id`.
 *
 * Member-scoped (`toMemberAccessContext`) for the same reason as GET /api/v1/data-lakes/{id}: a
 * platform admin who is not a member of the lake reaches neither its files nor its membership
 * through the public API.
 */
import type { Request, Response } from 'express';
import {
  addDataLakeFileContract,
  getDataLakeFileContract,
  removeDataLakeFileContract,
  type AccessContext,
  type DataLakeFileMembershipResponse,
  type DataLakeFileResponse,
  type IDataLakeDocument,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
  fabFileRepository,
  lakeMembershipRemovalRepository,
  scopedSettingsRepository,
} from '@bike4mind/database';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { rateLimit } from '@server/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@server/utils/userRateTier';
import { ForbiddenError, NotFoundError } from '@server/utils/errors';
import { toObjectIdString } from '@server/utils/objectId';
import { toMemberAccessContext } from '@server/dataLakes/toAccessContext';
import { lakeConfigAuditDb } from '@server/dataLakes/lakeConfigAuditDb';
import { lakeMembershipAuditDb } from '@server/dataLakes/lakeMembershipAuditDb';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';

// Required: the raw pathname embeds `id`/`file_id`, so without a stable bucket each file gets its
// own counter instead of one budget per caller.
const perUserRateLimit = () =>
  rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user),
    windowMs: 60 * 1000,
    bucket: '/api/v1/data-lakes/[id]/files/[file_id]',
  });

const lakeAccessDb = {
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  settings: adminSettingsRepository,
};

/** A malformed id can name no file, so it answers the same 404 as a missing one. */
function fileIdOrNotFound(rawFileId: string): string {
  const fileId = toObjectIdString(rawFileId);
  if (!fileId) throw new NotFoundError('File not found');
  return fileId;
}

/**
 * The membership-write gate: readable (404 otherwise), then manageable and not built-in (403).
 * Decided here from the manage rule itself rather than by matching the service's refusal text.
 */
async function assertLakeMembershipWritable(
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

const membershipWriteDb = {
  dataLakes: dataLakeRepository,
  dataLakeAccessGrants: dataLakeAccessGrantRepository,
  fabFiles: fabFileRepository,
  lakeMembershipRemovals: lakeMembershipRemovalRepository,
  // Without these the draft -> active flip a membership change can trigger records nothing; see
  // the SPA route (pages/api/data-lakes/[id]/files/[fabFileId].ts).
  ...lakeConfigAuditDb,
  ...lakeMembershipAuditDb,
};

const getRouter = nextRouteForContract(getDataLakeFileContract, { rateLimit: perUserRateLimit() })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
    const lake = await dataLakeService.assertLakeAccess(req.validatedParams.id, ctx, {
      db: lakeAccessDb,
      logger: req.logger,
    });
    const fileId = fileIdOrNotFound(req.validatedParams.file_id);
    const file = await fabFileRepository.findById(fileId);
    // Deleted and archived files are out of every search, so they are not members to report on.
    const isMember =
      !!file &&
      !file.deletedAt &&
      !file.archivedAt &&
      dataLakeService.satisfiesMembershipScope(dataLakeService.resolveLakeMembershipScope(lake), file);
    if (!file || !isMember) throw new NotFoundError('File not found');

    const body: DataLakeFileResponse = {
      lake_id: lake.id,
      file_id: file.id,
      file_name: file.fileName,
      ingestion_status: dataLakeService.classifyIngestionStatus(file),
      chunk_count: file.chunkCount ?? 0,
      vectorized_chunk_count: file.vectorizedChunkCount ?? 0,
      error: file.error || null,
    };
    return res.json(body);
  });

const addRouter = nextRouteForContract(addDataLakeFileContract, { rateLimit: perUserRateLimit() })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
    const lake = await assertLakeMembershipWritable(req.validatedParams.id, ctx, req.logger);
    const fileId = fileIdOrNotFound(req.validatedParams.file_id);
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo) };
    const result = await dataLakeService.addFileToDataLake(actor, lake.id, fileId, {
      db: { ...membershipWriteDb, scopedSettings: scopedSettingsRepository },
      logger: req.logger,
    });
    const body: DataLakeFileMembershipResponse = {
      lake_id: lake.id,
      file_id: fileId,
      file_count: result.fileCount,
      total_size_bytes: result.totalSizeBytes,
    };
    return res.json(body);
  });

const removeRouter = nextRouteForContract(removeDataLakeFileContract, { rateLimit: perUserRateLimit() })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .delete(async (req, res) => {
    const ctx = await toMemberAccessContext(req);
    const lake = await assertLakeMembershipWritable(req.validatedParams.id, ctx, req.logger);
    const fileId = fileIdOrNotFound(req.validatedParams.file_id);
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo) };
    const result = await dataLakeService.removeFileFromDataLake(actor, lake.id, fileId, {
      db: membershipWriteDb,
      logger: req.logger,
    });
    const body: DataLakeFileMembershipResponse = {
      lake_id: lake.id,
      file_id: fileId,
      file_count: result.fileCount,
      total_size_bytes: result.totalSizeBytes,
    };
    return res.json(body);
  });

// One contract per method, and nextRouteForContract refuses a verb its contract does not declare,
// so each method has its own router and this dispatches between them.
export default function handler(req: Request, res: Response) {
  // Each router's declared param type carries its contract's validated fields, which exist only
  // once its own prelude has run - a plain incoming Request satisfies that at runtime but not
  // structurally, hence the casts.
  if (req.method === 'POST') return addRouter(req as Parameters<typeof addRouter>[0], res);
  if (req.method === 'DELETE') return removeRouter(req as Parameters<typeof removeRouter>[0], res);
  return getRouter(req as Parameters<typeof getRouter>[0], res);
}

export const config = {
  api: { externalResolver: true },
};
