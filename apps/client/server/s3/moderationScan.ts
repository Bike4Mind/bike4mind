import { adminSettingsRepository, FabFile } from '@bike4mind/database';
import { moderateImageOrThrow } from '@bike4mind/services/llm/imageModerationGate';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { RekognitionImageModerationService } from '@bike4mind/utils/imageModeration';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { generateUploadConstraintFor } from '@bike4mind/server-utils/files/generateUploadMarker';
import { moderateUploadedFile } from '@bike4mind/server-utils/s3/moderateUploadedFile';
import type { ClientSession, Types } from 'mongoose';
import { imageModerationIncidents } from '@server/moderation/imageModerationIncidents';

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

/** A landing that kept losing its compare-and-set to concurrent reconciliations; the caller retries it. */
export class ModerationVersionRaceError extends Error {
  constructor(objectKey: string) {
    super(`Moderation version changed for ${objectKey}; retry the landing`);
    this.name = 'ModerationVersionRaceError';
  }
}

// One lost race is expected (a concurrent re-upload landed first) and a fresh read settles it, so
// it is retried here at warn rather than failing the invocation. Losing every attempt is not.
const MAX_LANDING_ATTEMPTS = 3;

/**
 * Reconciles moderation with the object currently in storage, never a notification's historical
 * ETag. A delayed event for A must not reopen a terminal verdict for the unchanged current B.
 * Read the row before HEAD and compare-and-set that snapshot: a delayed HEAD must not rewind a
 * newer reconciliation, even when the ETag has cycled back to an older value. A lost update race
 * re-runs the whole read-HEAD-CAS with a fresh snapshot; lookup failures and an exhausted race
 * throw so the landing retries instead of rescanning bytes under an unknown or stale version.
 */
export const recordLandedObject = async (
  fabFileId: FabFileKey,
  objectKey: string,
  logger: { warn: (message: string) => void }
): Promise<void> => {
  for (let attempt = 1; attempt <= MAX_LANDING_ATTEMPTS; attempt++) {
    if (await tryRecordLandedObject(fabFileId, objectKey)) return;
    if (attempt < MAX_LANDING_ATTEMPTS) {
      logger.warn(`Moderation version changed for ${objectKey} during landing; re-reading (attempt ${attempt})`);
    }
  }
  throw new ModerationVersionRaceError(objectKey);
};

/** One read-HEAD-CAS pass. Returns false only when a concurrent reconciliation won the race. */
const tryRecordLandedObject = async (fabFileId: FabFileKey, objectKey: string): Promise<boolean> => {
  const observed = await FabFile.findById(fabFileId).select('moderationETag moderationRevision').lean();
  if (!observed) return true;

  const eTag = normalizeETag((await getFilesStorage().getMetadata(objectKey)).etag);
  if (!eTag) throw new Error(`No ETag for ${objectKey}; moderation version not reconciled`);
  // An unchanged version needs no write: even a delayed HEAD here cannot reset a successor.
  if (observed.moderationETag === eTag) return true;

  const snapshot = {
    _id: fabFileId,
    moderationETag: observed.moderationETag ?? null,
    moderationRevision: observed.moderationRevision ?? null,
  };
  const judged = { $in: ['$moderationStatus', ['clean', 'blocked', 'scanning']] };
  const result = await FabFile.updateOne(snapshot, [
    {
      $set: {
        moderationETag: eTag,
        moderationRevision: { $add: [{ $ifNull: ['$moderationRevision', 0] }, 1] },
        moderationStatus: { $cond: [judged, 'pending', '$moderationStatus'] },
        blockReason: { $cond: [judged, '$$REMOVE', '$blockReason'] },
        moderationClaimedAt: { $cond: [judged, '$$REMOVE', '$moderationClaimedAt'] },
      },
    },
  ]);
  if (result.matchedCount) return true;
  const current = await FabFile.findById(fabFileId).select('moderationETag').lean();
  return current?.moderationETag === eTag;
};

/**
 * Atomically claims the right to scan: only ONE concurrent caller can move 'pending'/unset to
 * 'scanning'. Returns the claimed document, or null when another caller already owns (or finished)
 * the scan. `claimedAt` is the claim's identity - writeModerationVerdict and the rescue sweep match on it.
 * Version writes belong to recordLandedObject; claiming never rewinds that version snapshot.
 */
export const claimModerationScan = (fabFileId: FabFileKey, claimedAt: Date) =>
  FabFile.findOneAndUpdate(
    { _id: fabFileId, moderationStatus: { $in: ['pending', null] } },
    {
      $set: {
        moderationStatus: 'scanning',
        moderationClaimedAt: claimedAt,
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
    incidents: imageModerationIncidents,
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
