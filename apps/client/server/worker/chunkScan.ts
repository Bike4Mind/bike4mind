/**
 * Safety-net scan for the RAG ingestion pipeline (self-host worker).
 *
 * If the MinIO ObjectCreated webhook (pages/api/internal/s3/object-created.ts) is ever missed,
 * this sweep re-enqueues files that completed upload but were never chunked. Kept here (not
 * inline in main.ts) so the selection filter is unit-testable without importing the worker boot
 * graph.
 */

/** Only rescue files older than this, to avoid racing a webhook that is about to arrive. */
export const CHUNK_SCAN_MIN_AGE_MS = 2 * 60_000;
/** Cap files enqueued per scan pass so a large backlog is drained gradually. */
export const CHUNK_SCAN_BATCH = 50;

/**
 * Mongo filter selecting files the scan should re-enqueue for chunking.
 *
 * status:'complete' is the critical guard: it is set only once the object actually landed
 * (webhook / hosted upload flow). A failed or not-yet-finished upload stays 'pending', so it is
 * skipped here - otherwise the scan would re-enqueue a never-uploaded record every cycle onto a
 * chunk handler that can only fail (its bytes never arrived), poison out, and churn forever.
 * chunkCount / isChunking exclude already-chunked and in-progress files.
 */
export const buildFabFileChunkScanFilter = (cutoff: Date) => ({
  status: 'complete' as const,
  chunkCount: 0,
  isChunking: { $ne: true },
  createdAt: { $lt: cutoff },
  deletedAt: null,
});
