import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { finalizeBatchIfComplete, enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { Request } from 'express';
import { z } from 'zod';

/**
 * Caps the ids the cleanup below will scope into one $in. It is a clamp, never a rejection: an
 * oversized list still describes a real batch that has to be tallied and finalized at the bottom of
 * this handler, and refusing the request would leave that batch non-terminal - the exact hang this
 * route exists to prevent. Generous, since the cleanup is now a single query whose cost barely moves
 * with list length; the 1 MB body cap already bounds the array at roughly 38k.
 */
const MAX_FAILED_FILE_IDS = 10000;

/**
 * A 24-char hex Mongo ObjectId string. Unvalidated, one malformed id made the id-scoped read throw a
 * Mongoose CastError, which errorHandler renders as a 404 - logged at warn, so it never alerted.
 *
 * Applied as a FILTER in the handler, not as a schema refinement. Rejecting is the same failure
 * class as the length cap: a ZodError from the parse on the first line skips the cleanup, the tally,
 * the status flip and finalize, so one bad id hangs a batch the client never hears about. Filtering
 * keeps the reason the shape check exists - no unvalidated string reaches the query - without
 * spending terminality to get it.
 */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const UploadCompleteInput = z.object({
  batchId: z.string(),
  // Count of files whose browser upload PUT failed. These never reach S3, so the
  // server pipeline emits no event for them - the client is the only source of truth
  // for this tally, and it must count toward completion or the batch hangs.
  failedFiles: z.number().int().nonnegative().optional(),
  // Deliberately unbounded: these are written by a single $set, so length costs nothing here,
  // and the presign-failure path reports names with no ids at all - capping them would 422 a
  // fully-failed append and hang the very batch this route terminalizes.
  failedFileNames: z.array(z.string()).optional(),
  // FabFile ids the failed uploads left behind (created at presign, 0 chunks, no S3
  // object). Removed here so they don't inflate the lake's file count. Deliberately unconstrained
  // here: both the shape check and the length bound are applied in the handler as a filter and a
  // clamp, so a malformed or oversized list still tallies and finalizes instead of 422ing the batch
  // into a three-hour hang. See OBJECT_ID_RE and MAX_FAILED_FILE_IDS.
  failedFileIds: z.array(z.string()).optional(),
});

/**
 * Signals the end of a batch's browser-upload phase, cleaning up and accounting for
 * uploads that failed client-side. Called once per batch after the wizard finishes
 * uploading, whenever the lake is kept (partial success, or an append that fully failed).
 *
 * Two problems it fixes together, server-side, in the right order:
 * - Browser-failed files never enter the chunk/vectorize pipeline, so without an explicit
 *   tally the completion check (vectorizedFiles + failedFiles + skippedFiles >= totalFiles)
 *   is never satisfied and the batch hangs 'processing'. The increment is atomic ($inc) so
 *   it can't clobber a concurrent pipeline increment on the same counter.
 * - Their FabFile records are 0-chunk orphans that computeDataLakeStats would still count.
 *   Deleting them BEFORE finalize (which recomputes lake stats) keeps the file count honest;
 *   doing it here rather than in a separate client call removes an ordering/lost-write race.
 */
const handler = baseApi()
  .use(requireFeatureEnabled('EnableDataLakes'))
  .post(async (req: Request, res) => {
    const userId = req.user.id;
    const { batchId, failedFiles, failedFileNames, failedFileIds } = UploadCompleteInput.parse(req.body);

    // Shared with the presign/create routes (see assertBatchOwnership) - this route doesn't
    // attach a new file, but it still mutates an existing batch by a client-suppliable id, so
    // the same ownership guard applies.
    await dataLakeService.assertBatchOwnership(userId, batchId, { db: { batches: dataLakeBatchRepository } });

    // Remove the orphan FabFiles the failed uploads created. A plain soft-delete is
    // complete for these: 0 chunks (nothing to tear down), no S3 object (the PUT never
    // landed), and unreferenced (just created). Scope to files that are BOTH owned by the
    // caller AND stamped with this batch (presign sets FabFile.batchId), so a stale or
    // retried client sending stray ids can never delete the caller's other files.
    // One scoped updateMany rather than two queries per id: the previous per-id loop ran before the
    // status flip and finalize below, so a long list timed the request out and left the batch hanging.
    if (failedFileIds?.length) {
      // Filtered, then clamped - both degrade the request rather than refusing it, for the same
      // reason: everything below this point is what terminalizes the batch.
      const wellFormed = failedFileIds.filter(id => OBJECT_ID_RE.test(id));
      if (wellFormed.length < failedFileIds.length) {
        req.logger.warn(
          `upload-complete: batch ${batchId} sent ${failedFileIds.length - wellFormed.length} malformed file id(s), skipping them`
        );
      }
      const ids = wellFormed.slice(0, MAX_FAILED_FILE_IDS);
      if (ids.length < wellFormed.length) {
        // Clamped, not refused. The excess orphans stay behind and keep inflating the lake's file
        // count until someone deletes them, but the batch still reaches a terminal state below,
        // which is the worse of the two failures to leave in place.
        req.logger.warn(
          `upload-complete: batch ${batchId} reported ${wellFormed.length} failed file ids, cleaning up the first ${ids.length}`
        );
      }
      if (ids.length) {
        // The count matters because moving the ownership guard into the query filter also made a
        // refusal SILENT: an id belonging to another user or another batch is simply not matched,
        // with no application-code branch left to notice. Reporting the shortfall turns a stale or
        // cross-scope client from invisible into greppable.
        const modified = await fabFileRepository.softDeleteByIdsForUserBatch(ids, userId, batchId);
        if (modified < ids.length) {
          req.logger.warn(
            `upload-complete: batch ${batchId} reported ${ids.length} failed file ids, ${modified} were in scope`
          );
        }
      }
    }

    // failedFileNames is client-only (the pipeline never writes it), so a plain set
    // races nothing.
    if (failedFileNames !== undefined) {
      await dataLakeBatchRepository.update({ id: batchId, failedFileNames });
    }
    if (failedFiles && failedFiles > 0) {
      await dataLakeBatchRepository.incrementCounter(batchId, 'failedFiles', failedFiles);
    }

    // Guarded, so a pipeline that already finalized this batch is not resurrected.
    await dataLakeBatchRepository.setStatusIfActive(batchId, 'processing');

    // Re-read so the completion check sees both this call's increment and any pipeline
    // increments that landed concurrently; finalize is itself guarded (runs once) and
    // recomputes lake stats from source - now that the orphans above are gone.
    const fresh = await dataLakeBatchRepository.findById(batchId);
    await finalizeBatchIfComplete(fresh, req.logger);

    // Background AI-tag suggestion: not gated on chunk/vectorize completion, only on the
    // browser upload phase being done - so this call still matters even though it usually
    // loses the claim now. finalizeBatchIfComplete above already tries the same guarded
    // enqueue when ingest happens to be complete already; this is the call that actually wins
    // it on the (more common) case where chunk/vectorize are still running.
    await enqueueTaxonomyAnalysisIfWanted(fresh, req.logger);

    return res.json({ success: true });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
