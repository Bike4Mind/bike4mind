import {
  chargedBytes,
  NotFoundError,
  type IFabFileRepository,
  type IUserDocument,
  type IUserRepository,
  type StorageChargeFields,
} from '@bike4mind/common';
import { checkStorageLimit } from '@bike4mind/utils';

/**
 * Storage accounting for rewriting an existing FabFile's bytes. Every rewrite site calls
 * `assertRewriteFits` before its upload and `commitContentRewrite` after it. Each write that changes a
 * row's charged bytes - this commit, or the upload's S3 event claim (apps/client/server/s3/storageCharge.ts)
 * - sets `fileSize` and the stamp in one atomic update and moves the owner's counter by
 * `newSize - chargedBytes(preImage)`, so the moves add up to the truth in any order, including
 * overlapping rewrites of one file. A guard test pins the known call sites, but only finds new ones
 * under its search roots (b4m-core/infra/src/__tests__/fabFileExtractedCountInvalidation.test.ts).
 */

export type RewriteStorageDb = {
  fabFiles: Pick<IFabFileRepository, 'commitContentRewrite'>;
  users: Pick<IUserRepository, 'findById' | 'incrementCurrentStorage'>;
};

type ChargeFields = StorageChargeFields & { fileSize?: number | null };

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
 * owner's counter by the difference. Returns false, with the counter untouched, when `filter` missed
 * (a lost race). The row write and the counter move are two writes, atomic only inside a caller's
 * transaction; a crash between them drifts the counter until a storage recalc.
 */
export async function commitContentRewrite(
  args: { fabFileId: string; newSize: number; set?: Record<string, unknown>; filter?: Record<string, unknown> },
  db: RewriteStorageDb
): Promise<boolean> {
  const { fabFileId, newSize, set, filter } = args;
  const pre = await db.fabFiles.commitContentRewrite(fabFileId, { ...set, fileSize: newSize }, filter);
  if (!pre) return false;

  const delta = newSize - chargedBytes(pre);
  if (delta !== 0) await db.users.incrementCurrentStorage(pre.userId, delta);
  return true;
}
