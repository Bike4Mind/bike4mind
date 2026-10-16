import { adminSettingsRepository, FabFile, imageModerationIncidentRepository } from '@bike4mind/database';
import { moderateImageOrThrow } from '@bike4mind/services/llm/imageModerationGate';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import { getFilesStorage } from '@server/utils/storage';
import { generateUploadConstraintFor } from '@bike4mind/server-utils/files/generateUploadMarker';
import { moderateUploadedFile } from '@bike4mind/server-utils/s3/moderateUploadedFile';
import type { ClientSession, Types } from 'mongoose';

// Scan-ownership primitives for the hosted-upload doors: the S3 ObjectCreated handler
// (objectCreated.ts) and the on-demand scan route (pages/api/files/[id]/moderate.ts). One
// compare-and-swap decides which of them owns a file's verdict. The knowledge-import doors
// (knowledgeModerationDeps.ts) keep their own filePath-keyed copy of the same 'pending'/unset ->
// 'scanning' predicate, so a change to the claim shape must be mirrored there.

export type ModerationVerdictPatch = {
  moderationStatus: 'clean' | 'blocked';
  blockReason?: string;
  mimeType?: string;
};

type FabFileKey = Types.ObjectId | string;

/** The verdict fields of a scan result; the byte-sniffed mimeType is applied by each caller. */
export const toVerdictPatch = (result: Awaited<ReturnType<typeof moderateUploadedFile>>): ModerationVerdictPatch => ({
  moderationStatus: result.moderationStatus,
  ...(result.blockReason ? { blockReason: result.blockReason } : {}),
});

/** S3 event ETags are bare, HeadObject's are quoted; compare them in one form. */
export const normalizeETag = (eTag: string | null | undefined): string | undefined =>
  eTag?.replace(/^"|"$/g, '') || undefined;

/**
 * Records that the object version `eTag` has landed. If the row's verdict (or in-flight scan) covers
 * a different version, the object was overwritten after it was judged - e.g. by re-PUTting a still
 * valid presigned URL - so the verdict is reset to 'pending' for a rescan, and an in-flight scan's
 * claim is dropped so its now-stale verdict cannot land. Run by both landing hooks (objectCreated.ts
 * and the self-host pages/api/internal/s3/object-created.ts) before they claim the scan. A rescan
 * always reads the current bytes, which are this version or newer, so out-of-order or redelivered
 * events only ever cost an extra scan.
 */
export const recordLandedObject = (fabFileId: FabFileKey, eTag: string) => {
  const judged = { $in: ['$moderationStatus', ['clean', 'blocked', 'scanning']] };
  return FabFile.updateOne({ _id: fabFileId, moderationETag: { $ne: eTag } }, [
    {
      $set: {
        moderationETag: eTag,
        moderationStatus: { $cond: [judged, 'pending', '$moderationStatus'] },
        blockReason: { $cond: [judged, '$$REMOVE', '$blockReason'] },
        moderationClaimedAt: { $cond: [judged, '$$REMOVE', '$moderationClaimedAt'] },
      },
    },
  ]);
};

/**
 * Atomically claims the right to scan: only ONE concurrent caller can move 'pending'/unset to
 * 'scanning'. Returns the claimed document, or null when another caller already owns (or finished)
 * the scan. `claimedAt` is the claim's identity - writeModerationVerdict and the rescue sweep match on it.
 * `eTag`, when given, must have been read before the bytes are, so it never names a newer version
 * than the one scanned (see recordLandedObject).
 */
export const claimModerationScan = (fabFileId: FabFileKey, claimedAt: Date, eTag?: string) =>
  FabFile.findOneAndUpdate(
    { _id: fabFileId, moderationStatus: { $in: ['pending', null] } },
    {
      $set: {
        moderationStatus: 'scanning',
        moderationClaimedAt: claimedAt,
        ...(eTag ? { moderationETag: eTag } : {}),
      },
    },
    { new: true }
  );

/**
 * Writes a terminal verdict guarded on the claim stamp, NOT on 'scanning' alone: the rescue sweep
 * (moderationRescueSweep.ts) returns a stale 'scanning' row to 'pending', so a slow scan can find its
 * claim superseded and an unguarded write would overwrite the successor's verdict, including
 * un-quarantining a confirmed 'blocked'. Same identity-guard shape as the chunk claim's release in
 * apps/workers/src/queueHandlers/fabFileChunk.ts. Returns whether the write landed.
 */
export const writeModerationVerdict = async (
  fabFileId: FabFileKey,
  claimedAt: Date,
  patch: ModerationVerdictPatch,
  session?: ClientSession
): Promise<boolean> => {
  const res = await FabFile.updateOne(
    { _id: fabFileId, moderationStatus: 'scanning', moderationClaimedAt: claimedAt },
    { $set: patch, $unset: { moderationClaimedAt: 1 } },
    { session }
  );
  return res.matchedCount > 0;
};

/**
 * Hands a claim back (scanning -> pending) after a transient scan failure, only if it is still
 * ours. The S3 event (if it has not fired yet) or the rescue sweep can then claim the file; an S3
 * event that already lost the claim to this caller exited normally and is not redelivered, so after
 * that only the sweep recovers it. The attempt bookkeeping is what the sweep's fairness sort and
 * backoff read, matching knowledgeModerationDeps.release.
 */
export const releaseModerationClaim = (fabFileId: FabFileKey, claimedAt: Date) =>
  FabFile.updateOne(
    { _id: fabFileId, moderationStatus: 'scanning', moderationClaimedAt: claimedAt },
    {
      $set: { moderationStatus: 'pending', moderationLastAttemptAt: new Date() },
      $inc: { moderationAttempts: 1 },
      $unset: { moderationClaimedAt: 1 },
    }
  );

/** Runs the byte scan for an uploaded object with the production detector and storage wiring. */
export const scanUploadedObject = async (args: {
  fabFile: { id: string; userId: string; mimeType?: string | null; sourceMetadata?: unknown };
  objectKey: string;
  logger: Parameters<typeof moderateUploadedFile>[0]['logger'];
}) => {
  const { fabFile, objectKey, logger } = args;
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  return moderateUploadedFile({
    userId: fabFile.userId,
    fabFileId: fabFile.id,
    mimeType: fabFile.mimeType ?? undefined,
    enabled: getSettingsValue('ImageModerationEnabled', settings) ?? true,
    service: new RekognitionImageModerationService(logger),
    incidents: imageModerationIncidentRepository,
    generateUpload: generateUploadConstraintFor(fabFile.sourceMetadata, async () => {
      const { size } = await getFilesStorage().getMetadata(objectKey);
      return size ?? Number.POSITIVE_INFINITY;
    }),
    downloadBytes: () => getFilesStorage().download(objectKey),
    downloadPartialBytes: length => getFilesStorage().downloadRange(objectKey, length),
    moderateImageOrThrow,
    logger,
  });
};
