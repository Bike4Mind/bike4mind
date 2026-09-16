import type { Logger } from '@bike4mind/observability';
import type { ImageModerationService } from '@bike4mind/utils/imageModeration';
import type { ImageModerationIncident } from '@bike4mind/common';
import type { moderateUploadedFile as ModerateUploadedFile } from '@server/s3/moderateUploadedFile';

/**
 * Minimal FabFile row shape the moderation loop needs back from the atomic claim.
 */
interface ClaimedFabFile {
  _id: unknown;
  id: string;
  mimeType?: string;
  /**
   * The exact `moderationClaimedAt` this claim was acquired with. Threaded back into `persist`,
   * `release` and `retireMissingObject` so each is guarded on the claim it owns rather than on
   * `moderationStatus: 'scanning'` alone: the rescue sweep's stale-claim reclaim can free this row
   * mid-scan and a successor can re-claim it, and an unguarded terminal write would then clobber the
   * successor's verdict. Required, not optional: today's only `claim` always returns it, and an
   * optional stamp here would let a future second claim implementation silently degrade every
   * guarded write below back to the bare `moderationStatus: 'scanning'` filter this comment warns
   * against, with no compiler or test catching it.
   */
  moderationClaimedAt: Date;
}

export interface ModerateImportedKnowledgeFilesArgs {
  /** S3 keys of the just-imported knowledge files, one per FabFile. */
  filePaths: string[];
  userId: string;
  enabled: boolean;
  service: ImageModerationService;
  incidents: { record(input: ImageModerationIncident): Promise<unknown> };
  moderateImageOrThrow: Parameters<typeof ModerateUploadedFile>[0]['moderateImageOrThrow'];
  moderate: typeof ModerateUploadedFile;
  logger: Logger;
  /**
   * Atomic compare-and-swap: flip `pending`/unset -> `scanning` for the row at `filePath`, or
   * return null if another invocation already owns the scan (the natural S3 ObjectCreated event
   * for this same object can be redelivered by S3 after the import commits) or the row is already
   * terminal. Returns the claimed row so the verdict can be written back to its `_id`.
   */
  claim(filePath: string): Promise<ClaimedFabFile | null>;
  /**
   * Persist the terminal verdict (and any byte-sniff-corrected mime / block reason), guarded on the
   * `claimedAt` stamp this run claimed with. Returns false when the guard misses - the claim was
   * superseded mid-scan - so the caller counts only a verdict that actually landed.
   */
  persist(
    _id: unknown,
    patch: { moderationStatus: 'clean' | 'blocked'; mimeType?: string; blockReason?: string },
    claimedAt: Date
  ): Promise<boolean>;
  /**
   * Release a claim back to `pending` after a transient scan failure so the row is never stranded on
   * `scanning`. Guarded on `claimedAt` like `persist`: a superseded run must not clear its
   * successor's claim, which would turn one takeover into a cascade. Returns whether the guard
   * matched, for parity with `persist`; the caller does not currently act on a dropped release since
   * the successor already owns the row either way.
   */
  release(_id: unknown, claimedAt: Date): Promise<boolean>;
  /**
   * When true, a scan that fails because the object does not exist in storage (NoSuchKey only, never
   * a bare 404 - see isMissingObjectError) SOFT-DELETES the row (via `retireMissingObject`) instead
   * of releasing it back to `pending`. Only
   * the rescue sweep sets this, and it selects only imported-knowledge rows already past the staleness
   * age floor, where a never-created object is a permanent orphan (an import whose bytes never
   * landed); releasing would re-select the same orphan every run - a poison batch that starves
   * genuinely-stranded rows. Soft-delete (a storage-cleanup outcome, not a content-policy `blocked`
   * verdict) drains it without an un-appealable false block. The fresh-import path leaves it unset,
   * so a young row's missing object is treated as transient and released for the sweep to retry later.
   */
  terminalOnMissingObject?: boolean;
  /**
   * Soft-delete a missing-object orphan (see `terminalOnMissingObject`). Distinct from `persist`
   * because a never-landed file is not a moderation verdict - it is retired, not blocked. Guarded on
   * `claimedAt` like `persist`/`release`: the row can be reclaimed and re-scanned clean by a
   * successor between this run's download failing and this call landing, and an unguarded delete
   * would destroy that successor's verdict rather than merely dropping one. Returns whether the
   * guard matched, so a superseded retire is not counted as a resolved file.
   */
  retireMissingObject(_id: unknown, claimedAt: Date): Promise<boolean>;
  downloadBytes(filePath: string): Promise<Buffer>;
  downloadPartialBytes(filePath: string, length: number): Promise<Buffer>;
}

/**
 * A storage read that failed because the OBJECT (not the bucket) does not exist (vs a transient
 * 5xx/throttle): S3's GetObject throws `NoSuchKey` for a key that was never written. Matched by the
 * error's `name`/`Code` only - deliberately NOT by a bare `$metadata.httpStatusCode === 404`, because
 * the AWS SDK maps `NoSuchBucket` to 404 identically, and a bucket misconfig (stage-name substitution
 * miss, a self-host `.env` typo) must be treated as transient, never as a permanent orphan to
 * soft-delete. Matches the AWS SDK v3 error shape structurally so this module needn't import the S3
 * client.
 */
function isMissingObjectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; Code?: string };
  return e.name === 'NoSuchKey' || e.Code === 'NoSuchKey';
}

/**
 * Scan knowledge files an import just wrote, OUT OF BAND and post-commit. The import stamps every
 * file `pending` (the schema default) and returns here once its transaction has committed - the
 * natural S3 ObjectCreated scan (see server/s3/objectCreated.ts) fires at upload time, before the
 * row exists inside the still-open import transaction, so it always bails; without this pass an
 * imported image would sit `pending` forever (unservable) which is why the import used to
 * mis-stamp it `clean` and bypass moderation entirely. The declared mimeType is attacker-supplied,
 * so `moderate` (moderateUploadedFile) byte-sniffs the real type: non-images resolve to `clean`
 * immediately, real image bytes take the Rekognition path. Shares moderateUploadedFile's verdict
 * logic and the fail-closed invariant with the upload-time path (objectCreated.ts) - a terminal
 * verdict is never re-scanned and a held file stays unservable 'pending' - but serializes via its
 * own atomic pending|null -> scanning claim, which is a different mechanism from objectCreated's
 * (that path never writes the interim 'scanning' state). Never throws - a failed scan leaves the
 * file held. Returns the count of files resolved this run (scanned clean/blocked, or soft-deleted as
 * a missing-object orphan); files skipped (claim lost) or released (transient failure) are not
 * counted.
 */
export async function moderateImportedKnowledgeFiles(
  args: ModerateImportedKnowledgeFilesArgs
): Promise<{ scanned: number }> {
  const {
    filePaths,
    userId,
    enabled,
    service,
    incidents,
    moderateImageOrThrow,
    moderate,
    logger,
    claim,
    persist,
    release,
    terminalOnMissingObject,
    retireMissingObject,
    downloadBytes,
    downloadPartialBytes,
  } = args;

  let scanned = 0;
  for (const filePath of filePaths) {
    let claimed: ClaimedFabFile | null = null;
    try {
      claimed = await claim(filePath);
      if (!claimed) continue; // owned by a redelivered S3 event, or already terminal

      const result = await moderate({
        userId,
        fabFileId: claimed.id,
        mimeType: claimed.mimeType,
        enabled,
        service,
        incidents,
        downloadBytes: () => downloadBytes(filePath),
        downloadPartialBytes: length => downloadPartialBytes(filePath, length),
        moderateImageOrThrow,
        logger,
      });

      const applied = await persist(
        claimed._id,
        {
          moderationStatus: result.moderationStatus,
          ...(result.correctedMimeType && result.correctedMimeType !== claimed.mimeType
            ? { mimeType: result.correctedMimeType }
            : {}),
          ...(result.blockReason ? { blockReason: result.blockReason } : {}),
        },
        claimed.moderationClaimedAt
      );
      if (applied) {
        scanned++;
      } else {
        // The rescue sweep reclaimed this row mid-scan and a successor now owns it. Dropping our
        // verdict is the correct outcome - the successor writes its own - but it is not progress
        // this run may count, or the sweep's own recovery accounting overstates itself.
        logger.warn(`Moderation claim for ${filePath} was superseded mid-scan; discarding this run's verdict`);
      }
    } catch (err) {
      if (claimed && terminalOnMissingObject && isMissingObjectError(err)) {
        // The object was never written to storage - an import whose bytes never landed leaves a
        // 'pending' row whose filePath points at a key that will never exist. Releasing it back to
        // 'pending' would re-select the same orphan on every sweep (a poison batch that can starve
        // genuinely-stranded rows), so retire it terminally. Soft-delete, NOT a 'blocked' verdict: a
        // missing object is a storage-cleanup fact, not a content-policy match, and a 'blocked' row is
        // un-appealable (no CAS re-claims it, no admin unblock route). A soft-deleted row drops out of
        // every deletedAt:null query, including this sweep, so it never recirculates.
        try {
          const retired = await retireMissingObject(claimed._id, claimed.moderationClaimedAt);
          if (retired) {
            scanned++; // count only a retire that actually landed; a superseded one is the successor's row now
            logger.warn(
              `Imported knowledge file ${filePath} has no stored object; soft-deleting (missing_object orphan)`
            );
          } else {
            logger.warn(`Retire claim for ${filePath} was superseded mid-scan; discarding this run's retire`);
          }
        } catch (retireErr) {
          logger.warn(
            `Failed to retire missing-object orphan ${filePath}: ${
              retireErr instanceof Error ? retireErr.message : String(retireErr)
            }`
          );
        }
        continue;
      }
      // Transient failure (Rekognition throttle/5xx, download error): release the claim so the
      // file stays held ('pending') and never stuck on 'scanning'. Fail-closed: still not servable.
      if (claimed) await release(claimed._id, claimed.moderationClaimedAt).catch(() => undefined);
      logger.warn(
        `Failed to moderate imported knowledge file ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { scanned };
}
