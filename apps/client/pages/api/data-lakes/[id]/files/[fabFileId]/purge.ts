import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, fabFileRepository, fabFileChunkRepository } from '@bike4mind/database';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { DataLakeAuditEvents, logAuditEvent } from '@server/utils/auditLog';

/**
 * POST /api/data-lakes/:id/files/:fabFileId/purge
 * Permanently destroys one lake document, its chunks and their vectors, and answers with the
 * receipt proving it (see purgeDataLakeDocument). Unrecoverable and NOT lake-scoped - the sibling
 * DELETE on this path is the reversible, membership-only removal.
 *
 * POST rather than DELETE so the two cannot be confused by a client that only varies the method:
 * one unpicks membership, the other destroys the file everywhere.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    const ctx = await toAccessContext(req);

    const lake = await dataLakeService.assertLakeAccess(id, ctx, { db: { dataLakes: dataLakeRepository } });
    dataLakeService.assertLakeWritable(lake);

    const receipt = await dataLakeService.purgeDataLakeDocument(
      { userId: ctx.userId, isAdmin: ctx.isAdmin },
      lake.id,
      fabFileId,
      {
        db: {
          dataLakes: dataLakeRepository,
          fabFiles: fabFileRepository,
          fabFileChunks: fabFileChunkRepository,
        },
        // Undefined everywhere except self-host OpenSearch - Atlas's vector index lives on the
        // FabFileChunk collection itself, so the chunk delete already removes it. Same wiring as
        // the phase-2 lake sweep (dataLakeCleanup); a door left unwired keeps stale vectors.
        retrievalIndex: selfHostOpenSearchEnabled()
          ? dataLakeService.openSearchRetrievalIndex({
              db: { fabFileChunks: fabFileChunkRepository },
              searchIndex: FabFileChunkSearchIndex,
            })
          : undefined,
        logger: req.logger,
      }
    );

    // The durable half of the record. The CloudWatch line the service emits is per-invocation and
    // ages out; this is the one an owner or an auditor can still query months later, and it
    // carries `verified` so an incomplete sweep is not filed as a successful one.
    await logAuditEvent(
      {
        userId: ctx.userId,
        action: DataLakeAuditEvents.LAKE_DOCUMENT_PURGED,
        metadata: { ...receipt },
      },
      req.logger
    );

    return res.json(receipt);
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
