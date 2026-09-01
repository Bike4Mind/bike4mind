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
import { Types } from 'mongoose';
import { toAccessContext } from '@server/dataLakes/toAccessContext';
import { getFilesStorage } from '@server/utils/storage';
import { DataLakeAuditEvents, logAuditEvent } from '@server/utils/auditLog';
import { resolveAuditPrincipal } from '@server/dataLakes/resolveAuditPrincipal';
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
// Same local helper the quest-plan routes use. Needed BEFORE the destructive call because
// `fabFileRepository.findById` hands a malformed id straight to Mongoose, which throws a CastError:
// not one of the gate errors below, so it would file an unverified-purge audit row for a request
// that never wrote anything.
const isValidObjectId = (id: string): boolean =>
  Types.ObjectId.isValid(id) && new Types.ObjectId(id).toString() === id;

const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request<{}, unknown, unknown, { id: string; fabFileId: string }>, res) => {
    const { id, fabFileId } = req.query;
    if (!isValidObjectId(fabFileId)) {
      throw new BadRequestError('Invalid file id');
    }
    const ctx = await toAccessContext(req);

    // Grant-aware and org-aware, exactly like the reversible DELETE on this same path: the whole
    // ctx and the grant repo, so the service decides the rule instead of the call site encoding
    // half of it by omission.
    const lake = await dataLakeService.assertLakeAccess(id, ctx, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
    });
    dataLakeService.assertLakeWritable(lake);

    // Distinguishes the two ways a `verified: false` row can be reached: a sweep that threw
    // part-way (nothing yet filed) from one that completed and then threw in the bookkeeping after
    // it. Without it an auditor cannot tell a partly-destroyed document from an intact one.
    let receiptFiled = false;
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
        // incomplete sweep is not filed as a successful one. `baseApi()` admits a `b4m_live_` key
        // here as well as a session, so the principal is resolved rather than assumed: a
        // key-driven destruction must not be filed as though the key's owner did it by hand.
        onReceipt: async receipt => {
          receiptFiled = true;
          await logAuditEvent(
            {
              userId: ctx.userId,
              action: DataLakeAuditEvents.LAKE_DOCUMENT_PURGED,
              metadata: { ...receipt, ...resolveAuditPrincipal(req.user!, req.apiKeyInfo) },
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
          // same helper both file-delete routes call, over the file's pre-delete tags. That lake's
          // own meta-tag is filtered out: it is in `tagNames`, and leaving it in would run a second
          // identical aggregation over the lake the service already rebuilt.
          const purgedLakeTag = lake.datalakeTag?.toLowerCase();
          const otherLakeTags = tagNames.filter(name => name.toLowerCase() !== purgedLakeTag);
          await recomputeStatsForLakeTags(otherLakeTags, {
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
      // A malformed id is refused above for the same reason.
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
            phase: receiptFiled ? 'post-destruction' : 'sweep',
            error: error instanceof Error ? error.message : 'Unknown error',
            ...resolveAuditPrincipal(req.user!, req.apiKeyInfo),
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
