import { ConflictError, ForbiddenError, HTTPError, type AuditChange } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import type { AdminUsersBulkUndoResult } from '@client/app/utils/adminUsersBulk';
import {
  EXECUTE_BUDGET_MS,
  UNDO_RECORD_GRACE_MS,
  USERS_BULK_CONCURRENCY,
  UndoRecordSchema,
  errorMessage,
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
  /** ms after the start past which no new chunk is started; defaults to EXECUTE_BUDGET_MS. */
  budgetMs?: number;
  /** Removes exactly these domains from blockedEmailDomains in one audited write; returns those removed. */
  unblockEmailDomains: (domains: string[], batchId: string) => Promise<string[]>;
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

  // Stripe cannot reinstate a canceled subscription; the user subscribes again if the ban was a mistake.
  if (snapshot.canceledSubscriptions) details.subscriptionsNotRestored = snapshot.canceledSubscriptions;

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
 * Runs under execute's time budget, so a batch that needed most of it cannot hit the request timeout
 * here: past the budget no new chunk starts and the result is `partial`. Users that fail or were not
 * attempted, and blocked domains that could not be released, are written back as a record of their
 * own, same admin and deadline, so a retry can finish them. The record is written only once the run
 * stops: rewriting it mid-run would let a second undo take it and revert the same users twice.
 */
export async function undoAdminUsersBulk(
  batchId: string,
  adminId: string,
  deps: UndoDeps
): Promise<AdminUsersBulkUndoResult> {
  const clock = deps.now ?? (() => new Date());
  const now = clock();
  const key = undoKey(batchId);
  const found = await deps.store.findByKey(key);
  if (!found) throw new HTTPError(HTTP_GONE, EXPIRED_MESSAGE);
  const record = parseRecord(found.result);
  if (record.adminId !== adminId) throw new ForbiddenError('Only the admin who ran a bulk action can undo it.');
  if (now.getTime() > new Date(record.undoExpiresAt).getTime()) throw new HTTPError(HTTP_GONE, EXPIRED_MESSAGE);
  if (!(await deps.store.deleteByKeyAndReturn(key))) throw new ConflictError('This bulk action was already undone.');

  const deadline = now.getTime() + (deps.budgetMs ?? EXECUTE_BUDGET_MS);
  const failures: { snapshot: UserUndoSnapshot; error: string }[] = [];
  let attempted = 0;
  // The first chunk always runs, so every undo makes progress however slow the database is.
  while (attempted < record.users.length && (attempted === 0 || clock().getTime() < deadline)) {
    const chunk = record.users.slice(attempted, attempted + USERS_BULK_CONCURRENCY);
    const outcomes = await Promise.all(chunk.map(snapshot => revertWithin(snapshot, record, deps)));
    attempted += chunk.length;
    failures.push(...outcomes.flatMap(outcome => (outcome ? [outcome] : [])));
  }
  const notAttempted = record.users.slice(attempted);
  const stillBlockedDomains = await unblockDomains(record, deps);
  if (failures.length > 0 || notAttempted.length > 0 || stillBlockedDomains.length > 0)
    await storeRetryRecord(
      record,
      [...failures.map(failure => failure.snapshot), ...notAttempted],
      stillBlockedDomains,
      deps
    );
  const stillBlocked = new Set(stillBlockedDomains);
  return {
    restored: attempted - failures.length,
    failed: failures.map(failure => ({ userId: failure.snapshot.userId, error: failure.error })),
    partial: notAttempted.length > 0,
    remaining: notAttempted.length,
    unblockedDomains: (record.blockedDomains ?? []).filter(domain => !stillBlocked.has(domain)),
    stillBlockedDomains,
    subscriptionsNotRestored: record.users.slice(0, attempted).flatMap(user => user.canceledSubscriptions ?? []),
  };
}

async function revertWithin(
  snapshot: UserUndoSnapshot,
  record: UndoRecord,
  deps: UndoDeps
): Promise<{ snapshot: UserUndoSnapshot; error: string } | null> {
  try {
    await deps.withTransaction(() => revertUser(snapshot, record, deps));
    return null;
  } catch (error) {
    deps.logger?.error('Users bulk undo failed for user', { userId: snapshot.userId, error });
    return { snapshot, error: errorMessage(error) };
  }
}

/** Releases the domains the batch blocked. Returns the ones still blocked because the write failed. */
async function unblockDomains(record: UndoRecord, deps: UndoDeps): Promise<string[]> {
  const domains = record.blockedDomains ?? [];
  if (domains.length === 0) return [];
  try {
    await deps.unblockEmailDomains(domains, record.batchId);
    return [];
  } catch (error) {
    deps.logger?.error('Users bulk undo failed to unblock email domains', { batchId: record.batchId, error });
    return domains;
  }
}

async function storeRetryRecord(
  record: UndoRecord,
  users: UserUndoSnapshot[],
  blockedDomains: string[],
  deps: UndoDeps
): Promise<void> {
  try {
    await deps.store.createOrUpdate({
      key: undoKey(record.batchId),
      result: { ...record, users, blockedDomains } satisfies UndoRecord,
      expiresAt: new Date(new Date(record.undoExpiresAt).getTime() + UNDO_RECORD_GRACE_MS),
    });
  } catch (error) {
    deps.logger?.error('Failed to store a users bulk undo retry record', { batchId: record.batchId, error });
  }
}
