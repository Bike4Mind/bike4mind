import { FabFile } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { moderateImportedKnowledgeFiles } from '@server/s3/moderateImportedKnowledgeFiles';
import { buildKnowledgeModerationDeps } from '@server/s3/knowledgeModerationDeps';

// A scan finishes in seconds, so a row still awaiting moderation past this is stranded, not
// in-flight. Mirrors the chunk sweep's stale-claim threshold.
const MODERATION_STALE_MS = 30 * 60_000;

// Imported-knowledge keys are `knowledge/<userId>/<suffix>` (see notebookImportService); ordinary
// presigned uploads are bare `<uuid>.<ext>` at the root. Used to gate ONLY the missing-object
// soft-delete (terminalOnMissingObject) to import rows: an ordinary upload's row is created before
// its bytes land, so a missing object there may be a not-yet-completed upload, not an orphan.
// Left-anchored so a future filePath index can seek it.
const KNOWLEDGE_KEY_PREFIX = /^knowledge\//;

// How long a row released by a FAILED attempt is held out of the selection. The failures this
// covers are the ones a retry cannot fix quickly - AccessDenied on the bucket, a Rekognition
// 5xx/throttle, a storage 503 - so re-selecting such a row on the very next 60s worker tick burns
// the window on a scan that is going to fail again. Only the transient release stamps
// moderationLastAttemptAt (the stale-claim reclaim below deliberately does not), so a crashed
// 'scanning' row is still recovered by the same run that reclaims it.
const MODERATION_RETRY_BACKOFF_MS = 60 * 60_000;

export interface ModerationRescueSweepArgs {
  /** Whether image moderation is on. When off, the sweep no-ops (see below) rather than whitewashing the held backlog. */
  enabled: boolean;
  limit: number;
  logger: Logger;
}

/**
 * Recover FabFiles whose moderation scan never completed. `moderationStatus` defaults to 'pending'
 * and is only ever moved to clean/blocked by a scan (isImageServeable withholds a URL until then), so
 * a stale 'pending' is always a failed or never-run scan - never a terminal-by-design state, and
 * therefore always safe to re-scan.
 *
 * Selection covers exactly the rows whose bytes are (or should be) present:
 *   - imported-knowledge rows (`knowledge/` key), whose post-commit import scan can fail with nothing
 *     to retry it - imports keep the schema-default `status: 'pending'`, so the prefix is their signal;
 *   - any row whose upload completed (`status: 'complete'`, which objectCreated writes the moment the
 *     S3 event fires - BEFORE the moderation claim, see objectCreated.ts) - this catches an ordinary
 *     presigned upload whose objectCreated scan crashed, the only recovery it has.
 * An abandoned presigned row (bytes never uploaded) keeps `status: 'pending'` and a bare key, so it
 * matches neither arm and is never selected: it has no bytes to scan, and re-selecting it every run
 * would starve the genuinely-stranded rows this sweep exists to rescue (reaping such rows is a separate
 * concern - see issue #2725).
 *
 * The missing-object soft-delete (terminalOnMissingObject) is passed true per-row for `knowledge/`
 * keys only: a knowledge row past the age floor whose object is gone is a permanent orphan to retire.
 * A selected ordinary row is `status: 'complete'` - its bytes did land - so a missing read there is a
 * storage blip, released as transient, never soft-deleted. See KNOWLEDGE_KEY_PREFIX.
 *
 * Repeated failure cannot starve a stranded row. A non-404 failure (AccessDenied, a Rekognition
 * 5xx/throttle, a storage 503) is released back to 'pending' and would otherwise be re-selected in
 * natural order at full cap every run, so a cluster of failing `knowledge/` imports could fill
 * `limit` and hide a genuinely stranded one forever. Two things prevent that, both keyed on the
 * bookkeeping the release writes (moderationAttempts / moderationLastAttemptAt):
 *   - the selection SORTS by moderationAttempts ascending, and an unset count sorts before any
 *     number, so a never-attempted row always takes precedence over any repeatedly-failing sibling
 *     no matter how many there are - the guarantee, independent of how the backoff is tuned;
 *   - a row released by a failed attempt is held out of the selection for MODERATION_RETRY_BACKOFF_MS,
 *     so a hot failure does not consume a window it is going to fail out of again.
 * Deliberately no terminal attempt cap: a give-up state would be unrecoverable, since there is no
 * operator re-scan route for a FabFile (unlike a published artifact's unblock path). A row keeps
 * being retried, just never ahead of a row that has not been tried.
 *
 * Re-scans in place with the same claim/persist wiring as the import path. Two callers, two very
 * different cadences: the hosted daily reconcile cron, and the self-host worker's 60s tick
 * (worker/main.ts). MODERATION_RETRY_BACKOFF_MS only bites on the latter - on the daily cadence the
 * last attempt is always at least a day old, so the fairness sort is the only mechanism doing work
 * there. Recovery latency is coarse but the held file is fail-closed (unservable) until it
 * completes, so lag is safe either way.
 */
export async function runModerationRescueSweep({
  enabled,
  limit,
  logger,
}: ModerationRescueSweepArgs): Promise<{ rescanned: number }> {
  // Fail-closed when moderation is off: do NOT re-scan the held backlog. A disabled scan resolves
  // 'clean' (moderateUploadedFile returns clean before reading a byte), so running the sweep would
  // terminally whitewash every row held 'pending'/'scanning' WHILE moderation was on - permanently
  // un-gating files that were withheld for scanning, with no writer to revisit 'clean'. Disabling
  // the setting must only affect files handled during the off window; the held backlog stays held
  // (unservable) and is re-scanned by a later sweep once moderation is turned back on. Mirrors
  // chunkRescueSweep, which reads its own setting and early-returns rather than scanning disabled.
  if (!enabled) return { rescanned: 0 };

  const cutoff = new Date(Date.now() - MODERATION_STALE_MS);
  const retryAfter = new Date(Date.now() - MODERATION_RETRY_BACKOFF_MS);

  // A row stranded on 'scanning' (a claim whose scan crashed before releasing it) can never be
  // re-claimed by the pending|null CAS, so first return stale claims to 'pending'. Gate on
  // moderationClaimedAt (stamped when the claim was taken), not updatedAt: timestamps bumps updatedAt
  // on any write, so an unrelated edit to a scanning row would reset its staleness clock. Fall back
  // to updatedAt only for legacy rows claimed before moderationClaimedAt existed.
  //
  // Not scoped by filePath: this only moves 'scanning' -> 'pending' (never a terminal verdict), so it
  // is safe on any FabFile - and it is the ONLY writer that un-sticks an ordinary presigned upload
  // whose objectCreated scan crashed mid-claim (objectCreated's pending|null CAS can never re-claim
  // its own 'scanning' row).
  await FabFile.updateMany(
    {
      moderationStatus: 'scanning',
      deletedAt: null, // matches missing-or-null; never revive a soft-deleted row
      $or: [
        { moderationClaimedAt: { $lt: cutoff } },
        { moderationClaimedAt: { $exists: false }, updatedAt: { $lt: cutoff } },
      ],
    },
    {
      $set: { moderationStatus: 'pending' },
      // A crashed scan consumed an attempt, so count it: without this a row that crashes its
      // runner every time stays at attempts 0 and keeps winning the fairness sort forever. No
      // moderationLastAttemptAt stamp though - that would back the row off for a full window, and
      // this reclaim is the only door that frees it, so it would never be scanned by the same run.
      $inc: { moderationAttempts: 1 },
      // Only meaningful while 'scanning'; leaving it set would make the row's next claim
      // indistinguishable from a live one to the identity guards in knowledgeModerationDeps.
      $unset: { moderationClaimedAt: 1 },
    }
  );

  // Select stale 'pending' rows whose bytes are (or should be) present: imported-knowledge rows (their
  // `knowledge/` key is the signal, since imports keep the default status: 'pending'), OR any row whose
  // upload completed (status: 'complete', set by objectCreated before its scan claim - this catches an
  // ordinary upload whose scan crashed). An abandoned presigned row (status still 'pending', bare key,
  // no bytes) matches neither arm and is skipped, so it cannot recirculate and starve real strands.
  // filePath must exist and be non-empty (it is optional on the schema, and drives the claim/download).
  const stuck = await FabFile.find(
    {
      moderationStatus: 'pending',
      deletedAt: null, // matches missing-or-null; a soft-deleted upload is not stranded, skip it
      createdAt: { $lt: cutoff },
      filePath: { $exists: true, $ne: '' },
      // Two independent $ors, so they have to share an $and rather than one duplicate key.
      $and: [
        { $or: [{ filePath: KNOWLEDGE_KEY_PREFIX }, { status: 'complete' }] },
        // Backoff arm. `null` matches missing-or-null, so a row that has never failed is always
        // eligible; a $lt alone would exclude it, since $lt does not match across BSON type
        // brackets.
        { $or: [{ moderationLastAttemptAt: null }, { moderationLastAttemptAt: { $lt: retryAfter } }] },
      ],
    },
    { filePath: 1, userId: 1 }
  )
    // Fairness: never-attempted rows first (an unset count sorts before any number), then the
    // least-retried, oldest first. This is what makes starvation by a failing cluster impossible
    // rather than merely unlikely. Matches the leading keys of the sweep's index so the planner
    // streams in this order and stops at `limit`.
    .sort({ moderationAttempts: 1, createdAt: 1 })
    .limit(limit)
    .lean<Array<{ filePath: string; userId: string }>>();

  if (!stuck.length) return { rescanned: 0 };

  const deps = buildKnowledgeModerationDeps(logger);
  // Sequential and per file: each row carries its own owner, the set is small (a rare recovery),
  // and moderateImportedKnowledgeFiles never throws - a single bad file cannot abort the sweep.
  let rescanned = 0;
  for (const file of stuck) {
    // terminalOnMissingObject only for `knowledge/` keys: a swept import row past the age floor whose
    // object is gone is a permanent orphan, so soft-delete it (a storage-cleanup outcome, NOT a
    // content-policy block). A selected ordinary row is status: 'complete' - its bytes DID land - so a
    // missing read there is a storage blip; release it as transient rather than retire.
    const { scanned } = await moderateImportedKnowledgeFiles({
      filePaths: [file.filePath],
      userId: file.userId,
      enabled,
      terminalOnMissingObject: KNOWLEDGE_KEY_PREFIX.test(file.filePath),
      ...deps,
    });
    rescanned += scanned;
  }

  // rescanned counts files actually resolved to a terminal verdict this run, not merely selected:
  // a row skipped (claim lost to a concurrent scan) or released (transient failure) is not progress.
  logger.info('[ModerationRescueSweep] re-scanned stranded files', { rescanned, selected: stuck.length });
  return { rescanned };
}
