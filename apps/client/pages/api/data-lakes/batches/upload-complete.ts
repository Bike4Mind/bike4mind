import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { finalizeBatchIfComplete, enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { Request } from 'express';
import { z } from 'zod';

/**
 * How many ids the cleanup below scopes into one $in - a CHUNK SIZE, not a cap on what gets cleaned:
 * the loop keeps going until every well-formed id is covered, so no orphan is left behind.
 *
 * Total work is bounded upstream rather than by this number. The client always sends
 * `failedFileNames` in the same body as `failedFileIds` (dataLakeUploadPipeline.ts:483-484), so at
 * roughly 27 bytes per quoted id plus ~50 per name the 1 MB body cap admits on the order of 13k
 * failed files, not the ~38k an ids-only reading suggests. That makes this at most two iterations in
 * practice - which is why chunking is affordable where refusing is not: everything below this point
 * is what tallies and finalizes the batch, and a 422 here leaves it hanging.
 */
const FAILED_FILE_ID_CHUNK = 10000;

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
  // into a three-hour hang. See OBJECT_ID_RE and FAILED_FILE_ID_CHUNK.
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
      // Filtered, then chunked - the filter degrades the request rather than refusing it, and the
      // chunking keeps a long list from becoming one oversized $in. Neither refuses, for the same
      // reason: everything below this point is what terminalizes the batch.
      const wellFormed = failedFileIds.filter(id => OBJECT_ID_RE.test(id));
      if (wellFormed.length < failedFileIds.length) {
        req.logger.warn(
          `upload-complete: batch ${batchId} sent ${failedFileIds.length - wellFormed.length} malformed file id(s), skipping them`
        );
      }
      if (wellFormed.length > FAILED_FILE_ID_CHUNK) {
        // Counts what the CLIENT sent, not the post-filter total: a list that is both malformed and
        // oversized would otherwise under-report, reading "reported 10000" for a client that sent
        // more. Both numbers are given so the two degradations stay distinguishable in the log.
        req.logger.warn(
          `upload-complete: batch ${batchId} sent ${failedFileIds.length} failed file id(s) ` +
            `(${wellFormed.length} well-formed), cleaning up in chunks of ${FAILED_FILE_ID_CHUNK}`
        );
      }
      if (wellFormed.length) {
        // The count matters because moving the ownership guard into the query filter also made a
        // refusal SILENT: an id belonging to another user or another batch is simply not matched,
        // with no application-code branch left to notice. Reporting the shortfall turns a stale or
        // cross-scope client from invisible into greppable.
        let modified = 0;
        for (let i = 0; i < wellFormed.length; i += FAILED_FILE_ID_CHUNK) {
          modified += await fabFileRepository.softDeleteByIdsForUserBatch(
            wellFormed.slice(i, i + FAILED_FILE_ID_CHUNK),
            userId,
            batchId
          );
        }
        if (modified < wellFormed.length) {
          req.logger.warn(
            `upload-complete: batch ${batchId} reported ${wellFormed.length} well-formed failed file ids, ${modified} were in scope`
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
