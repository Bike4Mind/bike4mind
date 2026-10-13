import { baseApi } from '@server/middlewares/baseApi';
import { DATA_LAKE_READ_SCOPES } from '@server/dataLakes/dataLakeScopes';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository, lakeSkippedFileRepository } from '@bike4mind/database';
import type { ILakeSkippedFileDocument, LakeSkippedFileView, LakeSkippedFilesResponse } from '@bike4mind/common';
import { Request } from 'express';
import { z } from 'zod';
import { toAccessContext } from '@server/dataLakes/toAccessContext';

// Scalar-first coercion so a repeated param is a 400 - see findings/index.ts for the full reasoning.
const ListQuery = z.object({
  limit: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(1).max(200)).optional(),
  offset: z.union([z.string(), z.number()]).transform(Number).pipe(z.number().int().min(0)).optional(),
});

const DEFAULT_LIMIT = 50;

const toView = (row: ILakeSkippedFileDocument): LakeSkippedFileView => ({
  id: row.id,
  sourceKind: row.sourceKind,
  sourceId: row.sourceId,
  name: row.name,
  relativePath: row.relativePath,
  mimeType: row.mimeType,
  size: row.size,
  reason: row.reason,
  firstSeenAt: new Date(row.firstSeenAt).toISOString(),
  lastSeenAt: new Date(row.lastSeenAt).toISOString(),
});

/**
 * GET /api/data-lakes/:id/skipped-files - the files a connected source (Drive folder, GitHub repo)
 * holds that the lake sync refused to ingest, newest-skipped first, with the reason. See
 * ILakeSkippedFile for the record's lifecycle.
 *
 * MANAGE-gated: the rows name files and paths in the connector owner's source that never became
 * lake members, so a lake reader has no claim to them. `total` is counted separately from the page
 * so the chip's number stays exact above the page size.
 */
const handler = baseApi({ requiredScopes: DATA_LAKE_READ_SCOPES })
  .use(requireFeatureEnabled('EnableDataLakes'))
  .get(async (req: Request, res) => {
    const { id } = req.query as { id: string };
    const { limit, offset } = ListQuery.parse(req.query);
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeWriteAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });

    const pageLimit = limit ?? DEFAULT_LIMIT;
    const pageOffset = offset ?? 0;
    const [rows, total] = await Promise.all([
      lakeSkippedFileRepository.listByLake(lake.id, { limit: pageLimit, offset: pageOffset }),
      lakeSkippedFileRepository.countByLake(lake.id),
    ]);

    const body: LakeSkippedFilesResponse = {
      data: rows.map(toView),
      total,
      hasMore: pageOffset + rows.length < total,
    };
    return res.json(body);
  });

export const config = { api: { externalResolver: true } };

export default handler;
