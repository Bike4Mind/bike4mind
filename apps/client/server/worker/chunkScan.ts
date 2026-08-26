/**
 * Safety-net scan for the RAG ingestion pipeline.
 *
 * If the ingest event (MinIO webhook on self-host, S3 ObjectCreated on hosted) is ever missed -
 * or auto-chunk was disabled when the file landed - this sweep re-enqueues files that completed
 * upload but were never chunked. Consumed by the self-host worker (main.ts) and the hosted
 * dataLakeBatchReconcile cron. Kept here so the selection filter is unit-testable without
 * importing either boot graph.
 */
import { CONVERGENCE_PAUSED_NOTES } from '@bike4mind/common';

/** Only rescue files older than this, to avoid racing a webhook that is about to arrive. */
export const CHUNK_SCAN_MIN_AGE_MS = 2 * 60_000;
/** Global (not per-account) cap on files enqueued per scan pass, so a large backlog - even one
 * account's - is drained gradually without starving the run's time budget. */
export const CHUNK_SCAN_BATCH = 50;

/** A file claimed for chunking (isChunking:true) longer ago than this is treated as a stranded
 * claim - a worker hard-killed (OOM/timeout/deploy) before its `finally` cleared the flag - and is
 * eligible for rescue. Chosen to exceed the chunk handler's 13-minute hosted timeout
 * (infra/queues.ts), so on hosted a legitimately in-flight run is never reclaimed at all. Self-host
 * has no handler timeout, so a genuinely long run CAN be reclaimed there before it finishes - but
 * that no longer risks double-processing on either deployment: chunkFabfile's guarded-write
 * ownership check (#1802 Phase 2, chunk.ts) re-confirms this stamp before any write and aborts as a
 * benign no-op if a successor already took over. This value only trades off how soon a genuinely
 * stranded claim gets rescued against how long a reclaimed-but-still-running self-host worker keeps
 * doing now-discarded work before hitting that check.
 *
 * Two hosted consumers of this cutoff, not one: the daily `dataLakeBatchReconcile` sweep, AND
 * fabFileChunk.ts's own CAS re-evaluating it on every redelivery - so the practical hosted rescue
 * path is usually SQS's 60-minute visibility timeout re-delivering the message, which then sees the
 * claim as stale and proceeds, well before the daily sweep would ever see it. That also makes this
 * value load-bearing in the other direction: it must stay BELOW the queue's 60-minute visibility
 * timeout, or a redelivery would still see an in-flight-looking claim and decline, burning the
 * retry budget toward the DLQ instead of rescuing.
 *
 * Considered lowering this now that a claim is held for the WHOLE run (a hard-killed worker is
 * stuck claimed for up to this long, not just from wherever it died to its own premature release,
 * which no longer exists). Left at 30 minutes: since a too-early reclaim is now safe rather than
 * corrupting, the only cost of leaving this long is rescue latency for a genuinely stranded claim,
 * not correctness - and there's no production crash-rate data yet to justify tuning it against.
 * Lowering it further wouldn't meaningfully speed up hosted rescue anyway (SQS redelivery already
 * dominates), so the tradeoff is really self-host-only. */
export const CHUNK_CLAIM_STALE_MS = 30 * 60_000;

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
 *
 * ONE exception, and it is why the exclusion is an `$or` arm rather than a flat key: a media file
 * carrying `chunkRebuildRequestedAt` (#1939) is swept anyway. That stamp means a reset took the
 * file's state away and the enqueue that should have followed never landed - and this sweep is the
 * only door that reaches a file outside every data lake, so excluding it by mimeType would leave
 * the stamp with no automatic exit at all. `partitionByIndexAvailability` withholds a stamped file,
 * so the cost of no exit is a search that reports the file as "being re-indexed, returns on its
 * own" forever: a permanently false partial-results warning, which is the cries-wolf failure this
 * whole feature is built to avoid, reached from the other side.
 *
 * Bounded to one pass per file: the sweep enqueues, the chunker returns 0 chunks as it always would,
 * and `commitFabFileChunks` clears the stamp and writes the rollups - after which the handler's own
 * 'No extractable text' note excludes the file here again.
 */
export const NO_EXTRACTABLE_TEXT_NOTE_PREFIX = 'No extractable text';

export const buildFabFileChunkScanFilter = (cutoff: Date, staleClaimBefore?: Date) => ({
  status: 'complete' as const,
  chunkCount: 0,
  createdAt: { $lt: cutoff },
  deletedAt: null,
  // Two exclusions on `notes`, both settled-state markers the sweep must not re-enqueue:
  //  - the no-extractable-text note, this handler's own terminal outcome
  //  - the convergence pause markers. A paused file matches EVERY other clause here (the reset
  //    zeroed chunkCount, the pause writes no error, and it clears chunkRebuildRequestedAt - which
  //    is also what drops it out of the media clause's stamped-file exception below). While the
  //    kill switch is on it would be re-selected every pass, re-enqueued, and bounced straight back
  //    by the handler's own kill-switch check - pure no-op work that consumes the rescue cap and
  //    starves genuine lost-webhook candidates. Via CONVERGENCE_PAUSED_NOTES so this query and
  //    isConvergencePausedNote cannot drift; both markers reach both.
  notes: { $not: new RegExp(`^${NO_EXTRACTABLE_TEXT_NOTE_PREFIX}`), $nin: [...CONVERGENCE_PAUSED_NOTES] },
  error: { $in: [null, ''] },
  // Both clauses below are `$or`s, so they are nested under ONE `$and` rather than written as
  // sibling keys: two `$or` keys in the same object literal silently clobber each other (last key
  // wins), which here would drop either the media exclusion or the in-flight exclusion entirely.
  $and: [
    // Media exclusion, with the stamped-file exception - see the doc comment above.
    { $or: [{ mimeType: { $not: /^(audio|image|video)\// } }, { chunkRebuildRequestedAt: { $ne: null } }] },
    // Normally exclude in-flight files (isChunking:true). When a stale-claim cutoff is supplied, ALSO
    // rescue a claim older than it: a hard worker crash never runs the finally that clears isChunking,
    // so without this the file stays claimed and invisible forever. The `chunkClaimedAt:null` arm is
    // the BACKFILL: any file already stuck isChunking:true before chunkClaimedAt existed has no stamp,
    // which a `$lt` skips - so without it those files would stay unrescuable forever. It's safe
    // because every code path that sets isChunking:true now stamps chunkClaimedAt in the same write,
    // so a null stamp on an isChunking:true file can only be a pre-migration straggler, never a
    // legitimately in-flight one. The sweep does NOT re-claim before enqueue - it sends what this
    // filter selected, and a file already in flight loses the chunk worker's compare-and-set
    // (fabFileChunk.ts) and returns without re-chunking. Consequence worth knowing: a file that has
    // been reset and enqueued but not yet picked up still matches here, so a sweep pass landing in
    // that window re-sends it. The duplicate is harmless - it loses the CAS, or hits the `chunked`
    // guard after a successful run - but it does spend one of CHUNK_SCAN_BATCH's slots. The window is
    // normally sub-second, and the hosted sweep runs daily (infra/cron.ts), so this is a self-host
    // consideration in practice.
    staleClaimBefore
      ? {
          $or: [
            { isChunking: { $ne: true } },
            { isChunking: true, chunkClaimedAt: { $lt: staleClaimBefore } },
            { isChunking: true, chunkClaimedAt: null },
          ],
        }
      : { isChunking: { $ne: true } },
  ],
});
