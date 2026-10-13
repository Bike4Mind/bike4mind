import { NotFoundError, type IFabFileRepository, type IUserDocument, type IUserRepository } from '@bike4mind/common';
import { checkStorageLimit } from '@bike4mind/utils';

/**
 * Storage accounting for rewriting an existing FabFile's bytes. Every rewrite site calls
 * `assertRewriteFits` before its upload and `commitContentRewrite` after it, so the owner's
 * `currentStorageSize` moves by exactly `newSize - chargedBytes(row)`. The commit stamps
 * `storageChargedAt`, which makes the rewrite's S3 event claim nothing
 * (apps/client/server/s3/storageCharge.ts). A guard test pins the known call sites, but only finds
 * new ones under its search roots (b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts).
 */

export type RewriteStorageDb = {
  fabFiles: Pick<IFabFileRepository, 'commitContentRewrite'>;
  users: Pick<IUserRepository, 'findById' | 'incrementCurrentStorage'>;
};

type ChargeFields = { fileSize?: number; storageChargedAt?: Date | null };

/** Bytes a row currently contributes to its owner's counter: none until something charged it. */
export const chargedBytes = (row: ChargeFields) => (row.storageChargedAt ? (row.fileSize ?? 0) : 0);

/**
 * Throws the standard 400 "File size exceeds storage limit" when the rewrite would grow the
 * OWNER's usage past their quota. A shrinking or same-size rewrite never throws. `actor` is
 * reused when it is the owner, else the owner is loaded (an update-share editor is not charged).
 */
export async function assertRewriteFits(
  row: ChargeFields & { userId: string },
  newSize: number,
  db: Pick<RewriteStorageDb, 'users'>,
  actor?: IUserDocument
): Promise<void> {
  const growth = newSize - chargedBytes(row);
  if (growth <= 0) return;
  const owner = actor && actor.id === row.userId ? actor : await db.users.findById(row.userId);
  if (!owner) throw new NotFoundError('File owner not found');
  await checkStorageLimit(owner, growth);
}

/**
 * Writes `set` + `fileSize: newSize` and the charge stamp in one atomic update, then moves the
 * owner's counter by the difference. `uploadStartedAt` must be taken immediately before the upload.
 * Returns false, with the counter untouched, when `filter` missed (a lost race).
 */
export async function commitContentRewrite(
  args: {
    fabFileId: string;
    newSize: number;
    uploadStartedAt: Date;
    set?: Record<string, unknown>;
    filter?: Record<string, unknown>;
  },
  db: RewriteStorageDb
): Promise<boolean> {
  const { fabFileId, newSize, uploadStartedAt, set, filter } = args;
  const pre = await db.fabFiles.commitContentRewrite(fabFileId, { ...set, fileSize: newSize }, filter);
  if (!pre) return false;

  // A stamp at or after uploadStartedAt means this upload's S3 event already claimed and charged
  // newSize, so only the old bytes come off. Otherwise our stamp (app clock, taken after the upload
  // resolved) is later than the event's S3 eventTime, barring clock skew beyond the round-trip.
  const delta =
    pre.storageChargedAt && pre.storageChargedAt >= uploadStartedAt ? -chargedBytes(pre) : newSize - chargedBytes(pre);
  if (delta !== 0) await db.users.incrementCurrentStorage(pre.userId, delta);
  return true;
}
