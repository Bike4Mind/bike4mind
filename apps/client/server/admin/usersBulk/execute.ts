import { randomUUID } from 'node:crypto';
import { BadRequestError, ConflictError, type AuditChange } from '@bike4mind/common';
import {
  ADMIN_USERS_BULK_MAX,
  ADMIN_USERS_BULK_MAX_CREDIT_TOTAL,
  ADMIN_USERS_BULK_UNDO_WINDOW_MS,
  type AdminUsersBulkAction,
  type AdminUsersBulkExecuteRequest,
  type AdminUsersBulkResult,
  blocksEmailDomains,
} from '@client/app/utils/adminUsersBulk';
import type { AccountSubscriptionCancellation } from '@server/billing/cancelAccountSubscriptions';
import { emailDomainsOf } from './emailDomains';
import {
  cohortHashOf,
  creditDeltaFor,
  exceedsCreditTotal,
  netCreditsAdded,
  resolveAdminUsersBulk,
  type BulkUser,
  type ResolveDeps,
} from './resolve';
import {
  EXECUTE_BUDGET_MS,
  IDEMPOTENCY_TTL_MS,
  UNDO_RECORD_TTL_MS,
  USERS_BULK_CONCURRENCY,
  USER_OWNER_TTL_MS,
  errorMessage,
  idempotencyKey,
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

export type ExecuteDeps = ResolveDeps & {
  db: UsersBulkDb;
  store: UsersBulkStore;
  withTransaction: RunInTransaction;
  /** Strict: called inside the user's transaction, so a failed write rolls that user back. */
  audit: (entry: UsersBulkAuditEntry) => Promise<unknown>;
  /** The per-batch summary entry; best-effort, as every user is already committed when it is written. */
  auditSummary: (entry: { summary: string; details: Record<string, unknown> }) => Promise<unknown>;
  /**
   * Adds owned domains to blockedEmailDomains in one audited write, outside any user's transaction.
   * Returns the domains actually added (one already covered by the list is skipped).
   */
  blockEmailDomains: (domains: string[], batchId: string) => Promise<string[]>;
  /** Ends the user's realtime sockets after a ban or key revoke commits. Must not throw. */
  endRealtimeConnections: (userId: string) => Promise<unknown>;
  /**
   * Cancels the user's Stripe subscriptions after a suspend or contain commits, and audits it. Must
   * not throw: a Stripe failure is returned in `failed`, never undoes the ban.
   */
  cancelSubscriptions: (
    user: BulkUser,
    action: BanActionType,
    batchId: string
  ) => Promise<AccountSubscriptionCancellation>;
  logger?: UsersBulkLogger;
  now?: () => Date;
  newBatchId?: () => string;
  /** ms after the start past which no new chunk is started; defaults to EXECUTE_BUDGET_MS. */
  budgetMs?: number;
};

export type ExecuteActor = {
  id: string;
  /** The admin plus, under impersonation, the impersonated account: never acted on. */
  selfIds: string[];
};

const AUDIT_ACTION = {
  suspend: 'user.bulk.suspended',
  restrict: 'user.bulk.restricted',
  adjustCredits: 'user.bulk.credits_adjusted',
  revokeApiKeys: 'user.bulk.api_keys_revoked',
  addTag: 'user.bulk.tagged',
  contain: 'user.bulk.contained',
} as const satisfies Record<AdminUsersBulkAction['type'], UsersBulkAuditEntry['action']>;

export type BanActionType = Extract<AdminUsersBulkAction['type'], 'suspend' | 'contain'>;
const isBanAction = (type: AdminUsersBulkAction['type']): type is BanActionType =>
  type === 'suspend' || type === 'contain';

type UserOutcome =
  | { status: 'applied'; snapshot: UserUndoSnapshot; subscriptionCancelError?: string }
  | { status: 'skipped' }
  | { status: 'failed'; userId: string; error: string };

type ApplyContext = { action: AdminUsersBulkAction; actorId: string; reason: string; batchId: string };

const isDoneEntry = (data: unknown): data is { state: 'done'; result: AdminUsersBulkResult } =>
  typeof data === 'object' &&
  data !== null &&
  (data as { state?: unknown }).state === 'done' &&
  typeof (data as { result?: unknown }).result === 'object';

/** The steps for one user, inside its transaction. Returns null when nothing changed. */
async function applySteps(
  userId: string,
  { action, actorId, reason, batchId }: ApplyContext,
  deps: ExecuteDeps
): Promise<UserUndoSnapshot | null> {
  const { db } = deps;
  const user = await db.findUser(userId);
  if (!user) throw new Error('User not found');
  const snapshot: UserUndoSnapshot = { userId };
  const changes: AuditChange[] = [];
  const details: Record<string, unknown> = { batchId };
  let creditTransactionId: string | undefined;

  if ((action.type === 'suspend' || action.type === 'contain') && (await db.setFlag(userId, 'isBanned', true))) {
    snapshot.banned = true;
    changes.push({ field: 'isBanned', before: false, after: true });
  }
  if (action.type === 'restrict' && (await db.setFlag(userId, 'isModerated', true))) {
    snapshot.moderated = true;
    changes.push({ field: 'isModerated', before: false, after: true });
  }
  if (action.type === 'addTag' && (await db.addTag(userId, action.tag))) {
    snapshot.tagAdded = action.tag;
    changes.push({ field: 'tags', before: user.tags, after: [...user.tags, action.tag] });
  }

  const delta = creditDeltaFor(action, user.currentCredits);
  if (delta !== 0) {
    ({ creditTransactionId } = await db.adjustCredits({
      userId,
      delta,
      actorId,
      previousBalance: user.currentCredits,
      note: reason,
      batchId,
    }));
    snapshot.creditDelta = delta;
    changes.push({ field: 'currentCredits', before: user.currentCredits, after: user.currentCredits + delta });
    // recordAdminAction reads a positive `credits` as a grant and applies the grant thresholds to it.
    details.credits = delta;
  }

  // A ban always disables the user's keys, as the single-user admin update does on entering a blocked state.
  if (action.type === 'revokeApiKeys' || action.type === 'contain' || snapshot.banned) {
    const revoked = await db.revokeLiveApiKeys({ userId, revokedBy: actorId, reason, batchId });
    if (revoked.length > 0) {
      snapshot.apiKeys = revoked;
      details.keysRevoked = revoked.length;
    }
  }

  if (changes.length === 0 && !snapshot.apiKeys) return null;
  // In the transaction, so the owner entry and the change commit together. See userOwnerKey.
  await deps.store.createOrUpdate({
    key: userOwnerKey(userId),
    result: { batchId },
    expiresAt: new Date(Date.now() + USER_OWNER_TTL_MS),
  });
  await deps.audit({
    action: AUDIT_ACTION[action.type],
    user,
    summary: summaryFor(action, snapshot),
    changes,
    details,
    related: creditTransactionId ? { creditTransactionId } : undefined,
  });
  return snapshot;
}

function summaryFor(action: AdminUsersBulkAction, snapshot: UserUndoSnapshot): string {
  const parts: string[] = [];
  if (snapshot.banned) parts.push('suspended');
  if (snapshot.moderated) parts.push('restricted AI access');
  if (snapshot.tagAdded) parts.push(`tagged "${snapshot.tagAdded}"`);
  if (snapshot.creditDelta) {
    parts.push(`${snapshot.creditDelta > 0 ? 'granted' : 'deducted'} ${Math.abs(snapshot.creditDelta)} credits`);
  }
  if (snapshot.apiKeys) parts.push(`revoked ${snapshot.apiKeys.length} API key(s)`);
  return `${parts.join(', ')} in a bulk ${action.type} action`;
}

async function applyToUser(user: BulkUser, context: ApplyContext, deps: ExecuteDeps): Promise<UserOutcome> {
  try {
    const snapshot = await deps.withTransaction(() => applySteps(user.id, context, deps));
    if (!snapshot) return { status: 'skipped' };
    // After the commit, so a rollback never ends sockets for a ban that did not stick.
    if (snapshot.banned || snapshot.apiKeys) await deps.endRealtimeConnections(user.id);
    // Also after the commit: a Stripe cancel cannot roll back with the transaction. A contain on an
    // already-suspended user still cancels, so a ban from before this step existed is caught up.
    const { type } = context.action;
    if (!isBanAction(type)) return { status: 'applied', snapshot };
    return {
      status: 'applied',
      snapshot,
      ...(await cancelSubscriptionsOf(user, type, context.batchId, deps, snapshot)),
    };
  } catch (error) {
    deps.logger?.error('Users bulk action failed for user', { userId: user.id, error });
    return { status: 'failed', userId: user.id, error: errorMessage(error) };
  }
}

/**
 * Cancels after the ban committed, so the user is `applied` whatever Stripe does: a failure is
 * reported beside it, never as a failed user, which would drop the ban from the undo record.
 */
async function cancelSubscriptionsOf(
  user: BulkUser,
  action: BanActionType,
  batchId: string,
  deps: ExecuteDeps,
  snapshot: UserUndoSnapshot
): Promise<{ subscriptionCancelError?: string }> {
  try {
    const { canceled, failed } = await deps.cancelSubscriptions(user, action, batchId);
    if (canceled.length > 0) snapshot.canceledSubscriptions = canceled;
    return failed.length > 0 ? { subscriptionCancelError: failed.map(failure => failure.reason).join('; ') } : {};
  } catch (error) {
    deps.logger?.error('Users bulk subscription cancel failed for user', { userId: user.id, error });
    return { subscriptionCancelError: errorMessage(error) };
  }
}

/** Replays a finished batch with the same idempotency key, or refuses one still running. */
function replay(existing: unknown): AdminUsersBulkResult {
  if (isDoneEntry(existing)) return existing.result;
  throw new ConflictError('This bulk action is already running. Wait for it to finish.');
}

/**
 * Runs a confirmed bulk action. The target is resolved again and must still be exactly the users the
 * admin confirmed (count and cohort hash); each user is its own transaction, so a failure rolls back
 * only that user. Users run in chunks; after each chunk the undo record is rewritten to cover every
 * committed user, and once the time budget is spent no new chunk starts and the result is `partial`.
 * The idempotency key makes a retried request return the first result instead of acting twice.
 */
export async function executeAdminUsersBulk(
  request: AdminUsersBulkExecuteRequest,
  actor: ExecuteActor,
  deps: ExecuteDeps
): Promise<AdminUsersBulkResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().getTime();
  const batchId = (deps.newBatchId ?? randomUUID)();
  const idemKey = idempotencyKey(actor.id, request.idempotencyKey);
  const claim = await deps.store.claimDedup(idemKey, { state: 'running', batchId }, IDEMPOTENCY_TTL_MS);
  if (!claim.claimed) return replay(claim.existingData);

  let users: BulkUser[];
  let blockedDomains: string[];
  try {
    users = await confirmedCohort(request, actor, deps, new Date(startedAt));
    // Before any user, so no new account can sign up on these domains while the batch runs.
    blockedDomains = blocksEmailDomains(request.action) ? await blockDomainsOf(users, batchId, deps) : [];
  } catch (error) {
    // Nothing was touched (the domain write is one transaction), so release the key and let the admin retry with it.
    await deps.store.casDeleteDedup(idemKey, 'batchId', batchId).catch((releaseError: unknown) => {
      deps.logger?.error('Failed to release a users bulk idempotency key', { idemKey, error: releaseError });
    });
    throw error;
  }

  const context: ApplyContext = { action: request.action, actorId: actor.id, reason: request.reason, batchId };
  const deadline = startedAt + (deps.budgetMs ?? EXECUTE_BUDGET_MS);
  const snapshots: UserUndoSnapshot[] = [];
  const failed: AdminUsersBulkResult['failed'] = [];
  const subscriptionCancelFailures: AdminUsersBulkResult['subscriptionCancelFailures'] = [];
  let attempted = 0;
  const undoRecord = () => ({
    batchId,
    adminId: actor.id,
    action: request.action.type,
    users: snapshots,
    blockedDomains,
  });
  let undoExpiresAt = new Date(startedAt).toISOString();
  // Undoable even when every user is skipped, so the domains this batch blocked can be released.
  if (blockedDomains.length > 0) undoExpiresAt = await storeUndoRecord(undoRecord(), now(), deps);
  // The first chunk always runs, so every batch makes progress however slow the database is.
  while (attempted < users.length && (attempted === 0 || now().getTime() < deadline)) {
    const chunk = users.slice(attempted, attempted + USERS_BULK_CONCURRENCY);
    const outcomes = await Promise.all(chunk.map(user => applyToUser(user, context, deps)));
    attempted += chunk.length;
    let changed = false;
    for (const outcome of outcomes) {
      if (outcome.status === 'applied') {
        snapshots.push(outcome.snapshot);
        changed = true;
        if (outcome.subscriptionCancelError) {
          subscriptionCancelFailures.push({ userId: outcome.snapshot.userId, error: outcome.subscriptionCancelError });
        }
      } else if (outcome.status === 'failed') failed.push({ userId: outcome.userId, error: outcome.error });
    }
    if (changed) {
      undoExpiresAt = await storeUndoRecord(undoRecord(), now(), deps);
    }
  }

  const remaining = users.length - attempted;
  const result: AdminUsersBulkResult = {
    batchId,
    applied: snapshots.length,
    skipped: attempted - snapshots.length - failed.length,
    failed,
    partial: remaining > 0,
    remaining,
    undoExpiresAt,
    blockedDomains,
    canceledSubscriptions: snapshots.reduce((sum, s) => sum + (s.canceledSubscriptions?.length ?? 0), 0),
    subscriptionCancelFailures,
  };

  const stored = await deps.store
    .casUpdateDedup(idemKey, 'batchId', batchId, { state: 'done', batchId, result })
    .catch((error: unknown) => {
      deps.logger?.error('Failed to store a users bulk result for replay', { idemKey, error });
      return false;
    });
  if (!stored) deps.logger?.error('Users bulk idempotency entry was lost before completion', { idemKey });

  await deps
    .auditSummary({
      summary:
        `bulk ${request.action.type}: ${result.applied} applied, ${result.skipped} skipped, ${failed.length} failed` +
        (result.partial ? `, ${remaining} not attempted (time budget)` : '') +
        (blockedDomains.length > 0 ? `, ${blockedDomains.length} email domain(s) blocked` : '') +
        (result.canceledSubscriptions > 0 ? `, ${result.canceledSubscriptions} Stripe subscription(s) canceled` : '') +
        (subscriptionCancelFailures.length > 0
          ? `, ${subscriptionCancelFailures.length} user(s) with subscriptions not canceled`
          : ''),
      details: {
        batchId,
        target: request.target,
        action: request.action,
        applied: result.applied,
        skipped: result.skipped,
        partial: result.partial,
        remaining,
        blockedDomains,
        canceledSubscriptions: snapshots.flatMap(s =>
          s.canceledSubscriptions ? [{ userId: s.userId, subscriptionIds: s.canceledSubscriptions }] : []
        ),
        subscriptionCancelFailures,
        // A failed user's own entry rolled back with it, so this is the only record of the failure.
        failed,
      },
    })
    .catch((error: unknown) =>
      deps.logger?.error('[ADMIN_AUDIT_WRITE_FAILED]', { action: 'user.bulk.executed', error })
    );

  return result;
}

async function blockDomainsOf(users: readonly BulkUser[], batchId: string, deps: ExecuteDeps): Promise<string[]> {
  const { owned } = emailDomainsOf(users);
  return owned.length > 0 ? deps.blockEmailDomains(owned, batchId) : [];
}

/** Re-resolves the target and refuses anything but the exact cohort the admin confirmed. */
async function confirmedCohort(
  request: AdminUsersBulkExecuteRequest,
  actor: ExecuteActor,
  deps: ExecuteDeps,
  at: Date
): Promise<BulkUser[]> {
  const cohort = await resolveAdminUsersBulk(request.target, actor.selfIds, deps, at);
  if (cohort.overCap) {
    throw new BadRequestError(
      `A bulk action can act on at most ${ADMIN_USERS_BULK_MAX} users. Narrow the selection and try again.`
    );
  }
  if (cohort.eligible.length !== request.expectedCount || cohortHashOf(cohort.eligible) !== request.cohortHash) {
    throw new ConflictError('The matching users changed; review again.', {
      expectedCount: request.expectedCount,
      eligible: cohort.eligible.length,
    });
  }
  if (exceedsCreditTotal(netCreditsAdded(request.action, cohort.eligible))) {
    throw new BadRequestError(
      `A bulk action can add at most ${ADMIN_USERS_BULK_MAX_CREDIT_TOTAL} credits in total. Lower the amount or narrow the selection.`
    );
  }
  return cohort.eligible;
}

/**
 * Writes (or rewrites) the batch's undo record to cover every user committed so far. Returns the
 * undo deadline, or `at` when the record could not be written, so the client never offers an undo
 * that cannot run.
 */
async function storeUndoRecord(
  record: Omit<UndoRecord, 'undoExpiresAt'>,
  at: Date,
  deps: ExecuteDeps
): Promise<string> {
  const undoExpiresAt = new Date(at.getTime() + ADMIN_USERS_BULK_UNDO_WINDOW_MS).toISOString();
  try {
    await deps.store.createOrUpdate({
      key: undoKey(record.batchId),
      result: { ...record, undoExpiresAt } satisfies UndoRecord,
      expiresAt: new Date(at.getTime() + UNDO_RECORD_TTL_MS),
    });
    return undoExpiresAt;
  } catch (error) {
    deps.logger?.error('Failed to store a users bulk undo record', { batchId: record.batchId, error });
    return at.toISOString();
  }
}
