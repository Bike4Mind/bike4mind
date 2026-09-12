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
 * Re-scans in place with the same claim/persist wiring as the import path. Runs from the daily
 * reconcile cron; recovery latency is coarse but the held file is fail-closed (unservable) until it
 * completes, so lag is safe.
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
    { $set: { moderationStatus: 'pending' } }
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
      $or: [{ filePath: KNOWLEDGE_KEY_PREFIX }, { status: 'complete' }],
    },
    { filePath: 1, userId: 1 }
  )
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
