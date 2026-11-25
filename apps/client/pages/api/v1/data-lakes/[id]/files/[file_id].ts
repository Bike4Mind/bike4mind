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
import {
  addDataLakeFileContract,
  getDataLakeFileContract,
  removeDataLakeFileContract,
  type DataLakeFileMembershipResponse,
  type DataLakeFileResponse,
} from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, fabFileRepository, withTransaction } from '@bike4mind/database';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { resolveUserRateLimitPerMin } from '@bike4mind/server-utils/utils/userRateTier';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { toObjectIdString } from '@bike4mind/server-utils/utils/objectId';
import { toMemberAccessContext } from '@bike4mind/server-utils/dataLakes/toAccessContext';
import { lakeConfigAuditPrincipal } from '@server/dataLakes/lakeConfigAuditPrincipal';
import {
  addFileToWritableLake,
  assertLakeMembershipWritable,
  lakeAccessDb,
  membershipWriteDb,
} from '@server/dataLakes/lakeMembershipWrite';

// Required: the raw pathname embeds `id`/`file_id`, so without a stable bucket each file gets its
// own counter instead of one budget per caller.
const perUserRateLimit = () =>
  rateLimit({
    limit: req => resolveUserRateLimitPerMin(req.user, req),
    windowMs: 60 * 1000,
    bucket: '/api/v1/data-lakes/[id]/files/[file_id]',
  });

/** A malformed id can name no file, so it answers the same 404 as a missing one. */
function fileIdOrNotFound(rawFileId: string): string {
  const fileId = toObjectIdString(rawFileId);
  if (!fileId) throw new NotFoundError('File not found');
  return fileId;
}

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
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo) };
    const { lake, fileId, result } = await addFileToWritableLake({
      lakeIdOrSlug: req.validatedParams.id,
      ctx,
      actor,
      resolveFileId: () => fileIdOrNotFound(req.validatedParams.file_id),
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
    const actor = { ...ctx, auditPrincipal: lakeConfigAuditPrincipal(req.user, req.apiKeyInfo) };
    const { lake, fileId, result } = await withTransaction(async () => {
      const lake = await assertLakeMembershipWritable(req.validatedParams.id, ctx, req.logger);
      const fileId = fileIdOrNotFound(req.validatedParams.file_id);
      const result = await dataLakeService.removeFileFromDataLake(actor, lake.id, fileId, {
        db: membershipWriteDb,
        logger: req.logger,
      });
      await dataLakeRepository.touchIfStable(lake.id);
      return { lake, fileId, result };
    });
    const body: DataLakeFileMembershipResponse = {
      lake_id: lake.id,
      file_id: fileId,
      file_count: result.fileCount,
      total_size_bytes: result.totalSizeBytes,
    };
    return res.json(body);
  });

// One contract per method, each on its own router (see dispatchByMethod).
export default dispatchByMethod({ GET: getRouter, POST: addRouter, DELETE: removeRouter });

export const config = {
  api: { externalResolver: true },
};
