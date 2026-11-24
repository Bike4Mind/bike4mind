import { FabFile } from '@bike4mind/database';
import {
  claimModerationScan,
  recordLandedObject,
  releaseModerationClaim,
  scanUploadedObject,
  toVerdictPatch,
  writeModerationVerdict,
} from '@bike4mind/server-utils/s3/moderationScan';
import { sendToClient } from '@bike4mind/server-utils/websocket/utils';
import { Resource } from 'sst';
import type { Request } from 'express';
import { setTimeout as sleep } from 'node:timers/promises';

// Rekognition's own client loop has already retried without backoff by the time a scan throws.
const SCAN_RETRY_DELAY_MS = 400;

// Past this many failed attempts the scan is not run and the file is left to the rescue sweep.
const ROUTE_MAX_MODERATION_ATTEMPTS = 4;

// The S3 event normally owns a fresh upload's scan and lands its verdict within about a second, so a
// caller that loses the claim waits this long for that verdict instead of answering 'pending'.
const OWNER_VERDICT_WAIT_MS = 3000;
const OWNER_VERDICT_POLL_MS = 300;

export type ModerationNowStatus = 'clean' | 'blocked' | 'pending';

export type ModerationNowOutcome =
  { ok: true; moderationStatus: ModerationNowStatus } | { ok: false; reason: 'not_found' | 'no_storage_path' };

/**
 * On-demand moderation scan for a file the caller has just created, for POST /api/files/[id]/moderate and the chat
 * image job carry-forward (server/generations/chatImageJobRequest.ts).
 *
 * Uploads go straight to S3 and are only scanned when the ObjectCreated event fires, a few seconds
 * later. A caller that needs the file serveable right away (a brushed edit mask, uploaded and
 * dispatched in one user action) runs that same scan now.
 *
 * Shares the S3 handler's compare-and-swap claim, so the two never both scan or overwrite each
 * other's verdict. When the S3 event already owns the claim it is mid-scan, so this waits briefly
 * for its verdict rather than reporting 'pending'. Fail-closed throughout: a transient scanner
 * failure hands the claim back, is retried once, and otherwise reports 'pending', never 'blocked'.
 * If the S3 event has already fired it lost the claim to this call and will not be retried, so only
 * the rescue sweep recovers the file after that: it runs daily, only picks up rows idle 30+ minutes,
 * and backs off 60 minutes between attempts. Only call it for files used immediately,
 * never for durable uploads that would sit unscanned until the sweep.
 */
export async function moderateFabFileNow(params: {
  fabFileId: string;
  userId: string;
  logger: Request['logger'];
}): Promise<ModerationNowOutcome> {
  const { fabFileId, userId, logger } = params;
  const verdict = (moderationStatus: ModerationNowStatus): ModerationNowOutcome => ({ ok: true, moderationStatus });

  // Another owner (normally the S3 event) holds or won the verdict: wait for it to land, since it
  // is usually a fraction of a second away. Only a verdict that never lands reports 'pending'.
  const settleOnOwnerVerdict = async (reason: string): Promise<ModerationNowOutcome> => {
    for (let waited = 0; waited < OWNER_VERDICT_WAIT_MS; waited += OWNER_VERDICT_POLL_MS) {
      await sleep(OWNER_VERDICT_POLL_MS);
      const current = await FabFile.findById(fabFileId);
      if (current?.moderationStatus === 'clean' || current?.moderationStatus === 'blocked') {
        return verdict(current.moderationStatus);
      }
    }
    logger.warn('On-demand moderation left the file pending', { fabFileId, reason });
    return verdict('pending');
  };

  const fabFile = await FabFile.findById(fabFileId);
  // Same outcome for missing and not-owned so a caller doesn't leak which files exist.
  if (!fabFile || fabFile.userId !== userId) return { ok: false, reason: 'not_found' };
  const objectKey = fabFile.filePath;
  if (!objectKey) return { ok: false, reason: 'no_storage_path' };

  if (fabFile.moderationStatus === 'clean' || fabFile.moderationStatus === 'blocked') {
    return verdict(fabFile.moderationStatus);
  }

  if ((fabFile.moderationAttempts ?? 0) >= ROUTE_MAX_MODERATION_ATTEMPTS) return verdict('pending');

  // Version reconciliation owns its compare-and-set. A separate HEAD followed by an unconditional
  // version write in the claim could rewind a newer event's version while this request waited.
  try {
    await recordLandedObject(fabFile._id, objectKey, logger);
  } catch (error) {
    logger.warn('On-demand moderation could not reconcile the current object; leaving it pending', {
      fabFileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return verdict('pending');
  }
  let claimedAt = new Date();
  const claimed = await claimModerationScan(fabFile._id, claimedAt);
  // Lost the claim: the S3 event (or an earlier call) owns the verdict and will land it.
  if (!claimed) return settleOnOwnerVerdict('claim lost');

  try {
    const scan = () => scanUploadedObject({ fabFile, objectKey, logger });
    let result: Awaited<ReturnType<typeof scan>>;
    try {
      result = await scan();
    } catch (error) {
      logger.warn('On-demand moderation scan failed; retrying once', {
        fabFileId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Hand the claim back across the backoff instead of holding it, so an S3 event arriving in
      // the gap can claim and scan the file rather than being dropped on a lost claim.
      await releaseModerationClaim(fabFile._id, claimedAt);
      await sleep(SCAN_RETRY_DELAY_MS);
      claimedAt = new Date();
      if (!(await claimModerationScan(fabFile._id, claimedAt))) return settleOnOwnerVerdict('claim lost on retry');
      result = await scan();
    }
    if (result.moderationStatus === 'pending') {
      // The uploader's moderation allowance is spent: not a failure, so no attempt is counted and a
      // call after the window resets scans the file.
      await releaseModerationClaim(fabFile._id, claimedAt, { countAttempt: false });
      return verdict('pending');
    }
    // The byte-sniffed type rides in the guarded write: the S3 handler persists it through its own
    // save, but it will have lost the claim and skipped the scan by now.
    const landed = await writeModerationVerdict(fabFile._id, claimedAt, {
      ...toVerdictPatch(result),
      ...(result.correctedMimeType && result.correctedMimeType !== fabFile.mimeType
        ? { mimeType: result.correctedMimeType }
        : {}),
    });
    if (!landed) return settleOnOwnerVerdict('verdict write superseded');

    // The S3 handler's lost-claim branch reports 'pending' for a scan still in flight, so this
    // is the only place listeners learn the final verdict.
    await sendToClient(userId, Resource.websocket.managementEndpoint, {
      action: 'image_moderation_status',
      fabFileId: fabFile.id,
      moderationStatus: result.moderationStatus,
    }).catch(error =>
      logger.warn('Could not send image_moderation_status', {
        fabFileId,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return verdict(result.moderationStatus);
  } catch (error) {
    logger.warn('On-demand moderation scan failed; leaving the file pending', {
      fabFileId,
      error: error instanceof Error ? error.message : String(error),
    });
    await releaseModerationClaim(fabFile._id, claimedAt);
    return verdict('pending');
  }
}
