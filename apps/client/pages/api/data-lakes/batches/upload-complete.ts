import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { dataLakeBatchRepository, fabFileRepository } from '@bike4mind/database';
import { dataLakeService } from '@bike4mind/services';
import { finalizeBatchIfComplete, enqueueTaxonomyAnalysisIfWanted } from '@server/queueHandlers/dataLakeBatchProgress';
import { Request } from 'express';
import { z } from 'zod';

/**
 * Bounds the two client-supplied per-file arrays. Unbounded, the 1 MB body cap admitted roughly 38k
 * ids, and the cleanup below would then be a single request doing tens of thousands of round trips -
 * a Lambda timeout that leaves the batch non-terminal, because it fires BEFORE the status flip and
 * finalize at the bottom of this handler. Generous relative to any real batch's failure count.
 */
const MAX_FAILED_FILE_ENTRIES = 2000;

/** A 24-char hex Mongo ObjectId string. Unvalidated, one malformed id made the id-scoped read throw
 * a Mongoose CastError, surfacing as a 500 before the batch was ever finalized. */
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

const UploadCompleteInput = z.object({
  batchId: z.string(),
  // Count of files whose browser upload PUT failed. These never reach S3, so the
  // server pipeline emits no event for them - the client is the only source of truth
  // for this tally, and it must count toward completion or the batch hangs.
  failedFiles: z.number().int().nonnegative().optional(),
  failedFileNames: z.array(z.string()).max(MAX_FAILED_FILE_ENTRIES).optional(),
  // FabFile ids the failed uploads left behind (created at presign, 0 chunks, no S3
  // object). Removed here so they don't inflate the lake's file count. Shape-validated so a
  // malformed id is a 400 from this parse rather than a 500 from the cleanup read.
  failedFileIds: z
    .array(z.string().regex(OBJECT_ID_RE, 'failedFileIds must be 24-character hex ids'))
    .max(MAX_FAILED_FILE_ENTRIES)
    .optional(),
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
      await fabFileRepository.softDeleteByIdsForUserBatch(failedFileIds, userId, batchId);
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
