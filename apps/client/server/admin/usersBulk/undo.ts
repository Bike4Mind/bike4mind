import { ConflictError, ForbiddenError, HTTPError, type AuditChange } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import type { AdminUsersBulkUndoResult } from '@client/app/utils/adminUsersBulk';
import {
  UNDO_RECORD_GRACE_MS,
  UndoRecordSchema,
  errorMessage,
  inChunks,
  undoKey,
  userOwnerKey,
  type RunInTransaction,
  type UndoRecord,
  type UserUndoSnapshot,
  type UsersBulkAuditEntry,
  type UsersBulkDb,
  type UsersBulkLogger,
  type UsersBulkStore,
} from './ports';

export type UndoDeps = {
  db: UsersBulkDb;
  store: Pick<UsersBulkStore, 'findByKey' | 'deleteByKeyAndReturn' | 'createOrUpdate' | 'readDedup' | 'casDeleteDedup'>;
  withTransaction: RunInTransaction;
  /** Strict: called inside the user's transaction. */
  audit: (entry: UsersBulkAuditEntry) => Promise<unknown>;
  logger?: UsersBulkLogger;
  now?: () => Date;
};

const HTTP_GONE = 410;
const EXPIRED_MESSAGE = 'This bulk action can no longer be undone.';
export const SUPERSEDED_MESSAGE = 'Changed by a later bulk action; undo that one first.';

const parseRecord = (value: unknown): UndoRecord => {
  const parsed = UndoRecordSchema.safeParse(value);
  // A record this module wrote that no longer parses is a bug, not a client error: fail loudly.
  if (!parsed.success) throw new Error(`Corrupt users bulk undo record: ${parsed.error.message}`);
  return parsed.data;
};

/** Reverts one user's snapshot inside its transaction and writes the strict `user.bulk.undone` entry. */
async function revertUser(snapshot: UserUndoSnapshot, record: UndoRecord, deps: UndoDeps): Promise<void> {
  const { db, store } = deps;
  const { userId } = snapshot;
  // A newer batch that changed this user owns it: reverting ours would also revert part of theirs.
  const owner = await store.readDedup(userOwnerKey(userId));
  if (owner && owner.batchId !== record.batchId) throw new Error(SUPERSEDED_MESSAGE);
  const user = await db.findUser(userId);
  if (!user) throw new Error('User not found');
  const changes: AuditChange[] = [];
  const details: Record<string, unknown> = { batchId: record.batchId, undoneAction: record.action };
  let creditTransactionId: string | undefined;

  const unbanned = snapshot.banned === true && (await db.setFlag(userId, 'isBanned', false));
  if (unbanned) changes.push({ field: 'isBanned', before: true, after: false });
  if (snapshot.moderated && (await db.setFlag(userId, 'isModerated', false))) {
    changes.push({ field: 'isModerated', before: true, after: false });
  }
  if (snapshot.tagAdded && (await db.removeTag(userId, snapshot.tagAdded))) {
    changes.push({ field: 'tags', before: user.tags, after: user.tags.filter(tag => tag !== snapshot.tagAdded) });
  }
  if (snapshot.creditDelta) {
    // Reversing a grant never takes the balance below zero: credits spent since then stay spent.
    const reverse =
      snapshot.creditDelta > 0
        ? -Math.min(snapshot.creditDelta, Math.max(0, user.currentCredits))
        : -snapshot.creditDelta;
    if (reverse !== 0) {
      ({ creditTransactionId } = await db.adjustCredits({
        userId,
        delta: reverse,
        actorId: record.adminId,
        previousBalance: user.currentCredits,
        note: `Undo of bulk ${record.action} batch ${record.batchId}`,
        batchId: record.batchId,
      }));
      changes.push({ field: 'currentCredits', before: user.currentCredits, after: user.currentCredits + reverse });
      // A positive amount is a grant to recordAdminAction, held to the grant thresholds.
      details.credits = reverse;
    }
  }
  if (snapshot.apiKeys) {
    // Keys stay off while the account is still blocked for any other reason (a dispute, a suspension,
    // or a ban this batch did not set), as the single-user path never re-enables keys of a blocked account.
    const blockedBy = userService.accountBlockReasons({
      isBanned: unbanned ? false : user.isBanned,
      disputePending: user.disputePending,
      moderation: { status: user.moderationStatus },
    });
    if (blockedBy.length > 0) details.keysKeptDisabled = { count: snapshot.apiKeys.length, blockedBy };
    else details.keysReactivated = await db.reactivateApiKeys(userId, snapshot.apiKeys, record.batchId);
  }

  await store.casDeleteDedup(userOwnerKey(userId), 'batchId', record.batchId);
  await deps.audit({
    action: 'user.bulk.undone',
    user,
    summary: `undid a bulk ${record.action} action`,
    changes,
    details,
    related: creditTransactionId ? { creditTransactionId } : undefined,
  });
}

/**
 * Reverts a batch within ADMIN_USERS_BULK_UNDO_WINDOW_MS of executing it. Only the admin who ran it
 * may undo it, and the record is taken atomically, so two undos never both run. Refused with 410
 * Gone once the window has passed (or the record is gone), 409 when another undo already took it.
 * Users that fail are written back as a record of their own, same admin and deadline, so a retry
 * can finish them.
 */
export async function undoAdminUsersBulk(
  batchId: string,
  adminId: string,
  deps: UndoDeps
): Promise<AdminUsersBulkUndoResult> {
  const now = (deps.now ?? (() => new Date()))();
  const key = undoKey(batchId);
  const found = await deps.store.findByKey(key);
  if (!found) throw new HTTPError(HTTP_GONE, EXPIRED_MESSAGE);
  const record = parseRecord(found.result);
  if (record.adminId !== adminId) throw new ForbiddenError('Only the admin who ran a bulk action can undo it.');
  if (now.getTime() > new Date(record.undoExpiresAt).getTime()) throw new HTTPError(HTTP_GONE, EXPIRED_MESSAGE);
  if (!(await deps.store.deleteByKeyAndReturn(key))) throw new ConflictError('This bulk action was already undone.');

  const outcomes = await inChunks(record.users, async snapshot => {
    try {
      await deps.withTransaction(() => revertUser(snapshot, record, deps));
      return null;
    } catch (error) {
      deps.logger?.error('Users bulk undo failed for user', { userId: snapshot.userId, error });
      return { snapshot, error: errorMessage(error) };
    }
  });
  const failures = outcomes.flatMap(outcome => (outcome ? [outcome] : []));
  if (failures.length > 0)
    await storeRetryRecord(
      record,
      failures.map(failure => failure.snapshot),
      deps
    );
  return {
    restored: record.users.length - failures.length,
    failed: failures.map(failure => ({ userId: failure.snapshot.userId, error: failure.error })),
  };
}

async function storeRetryRecord(record: UndoRecord, users: UserUndoSnapshot[], deps: UndoDeps): Promise<void> {
  try {
    await deps.store.createOrUpdate({
      key: undoKey(record.batchId),
      result: { ...record, users } satisfies UndoRecord,
      expiresAt: new Date(new Date(record.undoExpiresAt).getTime() + UNDO_RECORD_GRACE_MS),
    });
  } catch (error) {
    deps.logger?.error('Failed to store a users bulk undo retry record', { batchId: record.batchId, error });
  }
}
