import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeService } from '@bike4mind/services';
import {
  changeStorageSize,
  dataLakeRepository,
  dataLakeAccessGrantRepository,
  fabFileRepository,
  fabFileChunkRepository,
  sessionRepository,
  withTransaction,
  User,
} from '@bike4mind/database';
import { FabFileChunkSearchIndex } from '@bike4mind/fab-pipeline';
import { selfHostOpenSearchEnabled } from '@bike4mind/db-core';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { DataLakeAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { recomputeStatsForLakeTags } from '@server/dataLakes/recomputeStatsForLakeTags';

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

    // Grant-aware and org-aware, exactly like the reversible DELETE on this same path: the whole
    // ctx and the grant repo, so the service decides the rule instead of the call site encoding
    // half of it by omission.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    const receipt = await dataLakeService.purgeDataLakeDocument(ctx, lake.id, fabFileId, {
      db: {
        dataLakes: dataLakeRepository,
        dataLakeAccessGrants: dataLakeAccessGrantRepository,
        fabFiles: fabFileRepository,
        fabFileChunks: fabFileChunkRepository,
        sessions: sessionRepository,
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
      onPurged: async ({ ownerUserId, fileSize, tagNames }) => {
        // Return the bytes, mirroring the +size that the upload event added. Every other
        // destruction path (single + bulk file delete, the drive-lake ingest sweep) does the same;
        // without it a purging owner's quota ratchets down with no way back but an admin
        // recalculate. The OWNER's, not the caller's - an admin may purge someone else's document.
        if (fileSize > 0) {
          try {
            await withTransaction(async session => {
              const owner = await User.findById(ownerUserId).session(session);
              if (owner) {
                await changeStorageSize(owner, -fileSize);
                await owner.save({ session });
              }
            });
          } catch (error) {
            req.logger.error('Error returning storage size after a permanent lake-document delete:', {
              error: error instanceof Error ? error.message : 'Unknown error',
              fileSize,
            });
          }
        }

        // The service recomputes the lake it was purged FROM. The destruction is global, so every
        // other lake that held the document would otherwise go on counting it forever - same
        // helper both file-delete routes call, over the file's pre-delete tags.
        await recomputeStatsForLakeTags(tagNames, {
          logger: req.logger,
          actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
        });
      },
      logger: req.logger,
    });

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
