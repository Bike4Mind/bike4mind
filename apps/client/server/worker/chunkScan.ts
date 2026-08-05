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
 * whose chunking threw gets `error` set. Both are terminal for this scan - re-enqueueing them
 * would re-fail identically every cycle; recovery for those is the explicit reprocess path,
 * which clears the markers.
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
