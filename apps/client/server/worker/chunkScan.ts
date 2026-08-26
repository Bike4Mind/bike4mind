/**
 * Safety-net scan for the RAG ingestion pipeline.
 *
 * If the ingest event (MinIO webhook on self-host, S3 ObjectCreated on hosted) is ever missed -
 * or auto-chunk was disabled when the file landed - this sweep re-enqueues files that completed
 * upload but were never chunked. Consumed by the self-host worker (main.ts) and the hosted
 * dataLakeBatchReconcile cron. Kept here so the selection filter is unit-testable without
 * importing either boot graph.
 */

/** Only rescue files older than this, to avoid racing a webhook that is about to arrive. */
export const CHUNK_SCAN_MIN_AGE_MS = 2 * 60_000;
/** Global (not per-account) cap on files enqueued per scan pass, so a large backlog - even one
 * account's - is drained gradually without starving the run's time budget. */
export const CHUNK_SCAN_BATCH = 50;

/**
 * Mongo filter selecting files the scan should re-enqueue for chunking.
 *
 * status:'complete' is the critical guard: it is set only once the object actually landed - by
 * the self-host upload proxy on a successful PUT (pages/api/files/[id]/upload.ts), by the MinIO
 * webhook, or by the hosted upload flow. Because the proxy marks complete independently of the
 * webhook, a lost webhook leaves a complete-but-unchunked file this scan can rescue. A failed or
 * not-yet-finished upload stays 'pending', so it is skipped here - otherwise the scan would
 * re-enqueue a never-uploaded record every cycle onto a chunk handler that can only fail (its
 * bytes never arrived), poison out, and churn forever. chunkCount / isChunking exclude
 * already-chunked and in-progress files.
 *
 * Two more churn guards, matching how the chunk handler records a terminal outcome
 * (fabFileChunk.ts): a file that chunked to zero gets a 'No extractable text' note, and a file
 * whose chunking exhausted its SQS retries gets `error` set. Both are terminal for this scan -
 * re-enqueueing them would re-fail identically every cycle; recovery for those is the explicit
 * reprocess path, which clears the markers. `error` is deliberately NOT set on a non-final
 * attempt (fabFileChunk.ts's deferFailureIfRetryable gate, #1412) so a file mid-retry can still
 * match this filter and get swept again - bounded, self-resolving churn (each pass caps at
 * CHUNK_SCAN_BATCH, and the final attempt sets `error`, closing the window), not corruption,
 * since claimFileStatus/markFailedIfNotAlready gate all the accounting either path takes.
 *
 * Audio, images and video are excluded up front: SmartChunker returns 0 chunks for all three
 * BY DESIGN (audio is never vectorizable; images are passed to models as URLs; video has no
 * extraction path and falls to the unsupported-type default), so sweeping them would burn the
 * per-run cap on no-op queue round-trips and stamp historical media files with a misleading
 * 'No extractable text' note. Query must stay in sync with isAudioMimeType and
 * SmartChunker.chunkImage / chunkFile's default branch.
 */
export const NO_EXTRACTABLE_TEXT_NOTE_PREFIX = 'No extractable text';

export const buildFabFileChunkScanFilter = (cutoff: Date) => ({
  status: 'complete' as const,
  chunkCount: 0,
  isChunking: { $ne: true },
  createdAt: { $lt: cutoff },
  deletedAt: null,
  mimeType: { $not: /^(audio|image|video)\// },
  notes: { $not: new RegExp(`^${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}`) },
  error: { $in: [null, ''] },
});

/** Grace period before the stranded-vectorize sweep touches a file, so it cannot race the chunk
 * handler's own SQS retries of the same failed enqueue. */
export const VECTORIZE_ENQUEUE_RESCUE_MIN_AGE_MS = 15 * 60_000;

/**
 * Mongo filter selecting files whose chunks were committed but whose vectorize fan-out failed -
 * fabFileChunk.ts stamps `vectorizeEnqueueFailedAt` when its enqueue throws.
 *
 * These files are invisible to buildFabFileChunkScanFilter above: that one requires
 * chunkCount: 0, and these files HAVE chunks. Without this sweep the state is terminal by
 * construction - the chunk handler's idempotency guard skips a redelivery and no other filter
 * selects it - leaving a file with chunks, no vectors and nothing looking at it.
 *
 * Rescue is a chunk-queue re-enqueue, like the un-chunked sweep, and is non-destructive: the
 * chunk handler refuses to re-chunk an already-chunked file and only re-sends the fan-out for
 * chunks that still lack a vector, clearing the stamp when it succeeds. Deliberately NOT gated on
 * enableAutoChunk (unlike the un-chunked sweep): that setting governs whether new uploads get
 * chunked, and this only finishes handing off work that was already chunked.
 */
export const buildStrandedVectorizeScanFilter = (cutoff: Date) => ({
  // $type is load-bearing, not decoration: the field defaults to null, and BSON type ordering puts
  // null BELOW a Date, so a bare `$lt: cutoff` would select every never-failed file in the
  // collection. It also matches the partial index's own predicate (FabFileModel.ts).
  vectorizeEnqueueFailedAt: { $type: 'date', $lt: cutoff },
  isChunking: { $ne: true },
  deletedAt: null,
});
