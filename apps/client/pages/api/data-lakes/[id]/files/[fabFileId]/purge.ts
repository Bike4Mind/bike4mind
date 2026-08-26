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
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { Request } from 'express';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { getFilesStorage } from '@server/utils/storage';
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

    try {
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
        // the phase-2 lake sweep (dataLakeCleanup); a door left unwired keeps stale vectors, which
        // is why the receipt distinguishes "collocated" from "unwired" rather than reporting both
        // as a bare false.
        retrievalIndex: selfHostOpenSearchEnabled()
          ? dataLakeService.openSearchRetrievalIndex({
              db: { fabFileChunks: fabFileChunkRepository },
              searchIndex: FabFileChunkSearchIndex,
            })
          : undefined,
        vectorsCollocated: !selfHostOpenSearchEnabled(),
        storage: getFilesStorage(),
        // The durable half of the record, filed BEFORE the best-effort bookkeeping below so a
        // throw in that bookkeeping cannot cost an irreversible destruction its only audit row.
        // The CloudWatch line the service emits is per-invocation and ages out; this is the one an
        // owner or an auditor can still query months later, and it carries `verified` so an
        // incomplete sweep is not filed as a successful one.
        onReceipt: async receipt => {
          await logAuditEvent(
            {
              userId: ctx.userId,
              action: DataLakeAuditEvents.LAKE_DOCUMENT_PURGED,
              metadata: { ...receipt },
            },
            req.logger
          );
        },
        onPurged: async ({ ownerUserId, fileSize, tagNames }) => {
          // Return the bytes, mirroring the +size that the upload event added. Every other
          // destruction path (single + bulk file delete, the drive-lake ingest sweep) does the
          // same; without it a purging owner's quota ratchets down with no way back but an admin
          // recalculate. The OWNER's, not the caller's - an admin may purge someone else's
          // document. `fileSize` is already 0 unless the stored object really went, so this can
          // never refund bytes that are still held.
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

          // The service recomputes the lake it was purged FROM. The destruction is global, so
          // every other lake that held the document would otherwise go on counting it forever -
          // same helper both file-delete routes call, over the file's pre-delete tags.
          await recomputeStatsForLakeTags(tagNames, {
            logger: req.logger,
            actor: { userId: ctx.userId, isAdmin: ctx.isAdmin },
          });
        },
        logger: req.logger,
      });

      return res.json(receipt);
    } catch (error) {
      // The writes are not transactional, so a throw mid-sweep can leave a partly (or wholly)
      // destroyed document behind. A destruction that ran must never be indistinguishable from one
      // that never did, so file the attempt as unverified before the error propagates. The
      // service's own gates (unknown lake, wrong actor, non-member file) throw these two before
      // anything is written, and an audit row for a refused request would be noise, not evidence.
      if (error instanceof BadRequestError || error instanceof NotFoundError) {
        throw error;
      }
      await logAuditEvent(
        {
          userId: ctx.userId,
          action: DataLakeAuditEvents.LAKE_DOCUMENT_PURGED,
          metadata: {
            dataLakeId: lake.id,
            fabFileId,
            verified: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        },
        req.logger
      );
      throw error;
    }
  });

export const config = {
  api: { externalResolver: true },
};

export default handler;
