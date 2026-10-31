import { CreditHolderType, type UserModerationStatus } from '@bike4mind/common';
import {
  User,
  UserApiKey,
  cacheRepository,
  creditTransactionRepository,
  mongoose,
  realtimeConnectionRepository,
  userApiKeyRepository,
  userRepository,
  withTransaction,
} from '@bike4mind/database';
import { authSessionService, creditService, type adminAuditService } from '@bike4mind/services';
import type { Logger } from '@bike4mind/observability';
import { adminUsersPipeline } from '@server/admin/usersList/listAdminUsers';
import { LIVE_API_KEY_STATUS } from '@server/admin/usersList/adminUsersQuery';
import { loadCreditGrantPolicy, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import {
  addBlockedEmailDomains,
  readBlockedEmailDomains,
  removeBlockedEmailDomains,
} from '@server/admin/blockedEmailDomains';
import { cancelAccountSubscriptions, subscriptionCancellationAudit } from '@server/billing/cancelAccountSubscriptions';
import type { ExecuteDeps } from './execute';
import type { UsersBulkAuditEntry, UsersBulkDb } from './ports';
import type { BulkUser, PreviewDeps, ResolveDeps } from './resolve';
import type { UndoDeps } from './undo';

type AuditRequest = Parameters<typeof recordAdminActionFromRequest>[0];

// ms. One page read; a filter the indexes cannot serve fails rather than queues.
const PAGE_MAX_TIME_MS = 10_000;

const BULK_USER_PROJECTION = {
  name: 1,
  email: 1,
  username: 1,
  isAdmin: 1,
  isBanned: 1,
  isModerated: 1,
  tags: 1,
  currentCredits: 1,
  disputePending: 1,
  'moderation.status': 1,
} as const;

type BulkUserRow = {
  _id: unknown;
  name?: string | null;
  email?: string | null;
  username?: string | null;
  isAdmin?: boolean | null;
  isBanned?: boolean | null;
  isModerated?: boolean | null;
  tags?: string[] | null;
  currentCredits?: number | null;
  disputePending?: boolean | null;
  moderation?: { status?: UserModerationStatus | null } | null;
};

const toBulkUser = (row: BulkUserRow): BulkUser => ({
  id: String(row._id),
  name: row.name ?? null,
  email: row.email ?? null,
  username: row.username ?? null,
  isAdmin: row.isAdmin === true,
  isBanned: row.isBanned === true,
  isModerated: row.isModerated === true,
  tags: row.tags ?? [],
  currentCredits: row.currentCredits ?? 0,
  disputePending: row.disputePending === true,
  moderationStatus: row.moderation?.status ?? null,
});

export const usersBulkResolveDeps: ResolveDeps = {
  findUsersByIds: async ids =>
    (
      await User.find({ _id: { $in: ids } })
        .select(BULK_USER_PROJECTION)
        .lean<BulkUserRow[]>()
    ).map(toBulkUser),
  openFilterPages: async (filter, now) => {
    // adminUsersPipeline leads with the filter's $match; the cursor and the sort go right there, ahead
    // of any later stages, so each page is an indexed range scan on _id.
    const [leading, ...rest] = await adminUsersPipeline(filter, now);
    if (!leading || !('$match' in leading)) throw new Error('adminUsersPipeline must start with a $match stage');
    return async (afterId, limit) =>
      (
        await User.aggregate<BulkUserRow>([
          afterId
            ? { $match: { $and: [leading.$match, { _id: { $gt: new mongoose.Types.ObjectId(afterId) } }] } }
            : leading,
          { $sort: { _id: 1 } },
          ...rest,
          { $limit: limit },
          { $project: BULK_USER_PROJECTION },
        ]).option({ maxTimeMS: PAGE_MAX_TIME_MS })
      ).map(toBulkUser);
  },
};

export const usersBulkPreviewDeps: PreviewDeps = {
  countLiveApiKeys: async userIds => {
    const rows = await UserApiKey.aggregate<{ _id: string; count: number }>([
      { $match: { userId: { $in: userIds }, status: LIVE_API_KEY_STATUS } },
      { $group: { _id: '$userId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map(row => [row._id, row.count]));
  },
  blockedEmailDomains: readBlockedEmailDomains,
};

export const usersBulkDb: UsersBulkDb = {
  findUser: async userId => {
    const row = await User.findById(userId).select(BULK_USER_PROJECTION).lean<BulkUserRow>();
    return row ? toBulkUser(row) : null;
  },
  setFlag: async (userId, field, value) =>
    (await User.updateOne({ _id: userId, [field]: { $ne: value } }, { $set: { [field]: value } })).modifiedCount > 0,
  addTag: async (userId, tag) =>
    (await User.updateOne({ _id: userId, tags: { $ne: tag } }, { $addToSet: { tags: tag } })).modifiedCount > 0,
  removeTag: async (userId, tag) =>
    (await User.updateOne({ _id: userId, tags: tag }, { $pull: { tags: tag } })).modifiedCount > 0,
  revokeLiveApiKeys: ({ userId, revokedBy, reason, batchId }) =>
    userApiKeyRepository.revokeLiveByUserId(userId, { revokedBy, revokedReason: reason, batchId }),
  reactivateApiKeys: (userId, keys, batchId) => userApiKeyRepository.reactivateByIds(userId, keys, batchId),
  adjustCredits: async ({ userId, delta, actorId, previousBalance, note, batchId }) => {
    // Same ledger rows and reason as the single-user admin adjustment (userService/adminUpdate.ts).
    const base = {
      ownerId: userId,
      ownerType: CreditHolderType.User,
      reason: 'admin_adjustment',
      description: 'Bulk admin credit adjustment',
      metadata: { actorId, previousBalance, resultingBalance: previousBalance + delta, note, batchId },
    } as const;
    const adapters = { db: { creditTransactions: creditTransactionRepository }, creditHolderMethods: userRepository };
    const { creditTransactionId } =
      delta > 0
        ? await creditService.addCreditsWithLedgerRow({ ...base, credits: delta, type: 'generic_add' }, adapters)
        : await creditService.subtractCreditsWithLedgerRow(
            { ...base, credits: -delta, type: 'generic_deduct' },
            adapters
          );
    return { creditTransactionId };
  },
};

/** The AdminSettings grant thresholds, read at most once per batch however many entries it writes. */
function oncePerBatchPolicy(): () => Promise<adminAuditService.CreditGrantPolicy> {
  let policy: Promise<adminAuditService.CreditGrantPolicy> | undefined;
  return () =>
    (policy ??= loadCreditGrantPolicy().catch((error: unknown) => {
      // Not cached on failure, so one transient settings read does not fail every user after it.
      policy = undefined;
      throw error;
    }));
}

const auditFor = (req: AuditRequest, reason: string) => {
  const creditGrantPolicy = oncePerBatchPolicy();
  return ({ action, user, summary, changes, details, related }: UsersBulkAuditEntry) =>
    recordAdminActionFromRequest(
      req,
      {
        action,
        target: { kind: 'user', id: user.id, displayName: user.email ?? user.username ?? user.id },
        summary,
        reason,
        changes,
        details,
        related,
      },
      { creditGrantPolicy }
    );
};

const runInTransaction =
  (logger?: Logger) =>
  <T>(fn: () => Promise<T>) =>
    withTransaction(() => fn(), { logger });

/** Execute deps whose audit entries carry the request's actor and the admin's reason. */
export function usersBulkExecuteDeps(req: AuditRequest, reason: string, logger?: Logger): ExecuteDeps {
  return {
    ...usersBulkResolveDeps,
    db: usersBulkDb,
    store: cacheRepository,
    withTransaction: runInTransaction(logger),
    audit: auditFor(req, reason),
    auditSummary: ({ summary, details }) =>
      recordAdminActionFromRequest(req, {
        action: 'user.bulk.executed',
        target: { kind: 'system', id: 'admin-users-bulk', displayName: 'Users bulk action' },
        summary,
        reason,
        details,
      }),
    blockEmailDomains: (domains, batchId) =>
      addBlockedEmailDomains(
        req,
        domains,
        added => `blocked signups from ${added.join(', ')} in bulk contain batch ${batchId}`
      ),
    endRealtimeConnections: userId =>
      authSessionService.endRealtimeConnections(
        { userId },
        { db: { realtimeConnections: realtimeConnectionRepository }, logger }
      ),
    cancelSubscriptions: async (user, action, batchId) => {
      const cancelReason = action === 'contain' ? 'contained' : 'suspended';
      const result = await cancelAccountSubscriptions({ userId: user.id, reason: cancelReason }, logger ?? console);
      const entry = subscriptionCancellationAudit(result, cancelReason);
      // Best-effort per the catalogue: the ban is committed, so a lost entry must not fail the user.
      if (entry) {
        await recordAdminActionFromRequest(req, {
          ...entry,
          target: { kind: 'user', id: user.id, displayName: user.email ?? user.username ?? user.id },
          reason,
          details: { ...entry.details, batchId },
        });
      }
      return result;
    },
    logger,
  };
}

export function usersBulkUndoDeps(req: AuditRequest, logger?: Logger): UndoDeps {
  return {
    db: usersBulkDb,
    store: cacheRepository,
    withTransaction: runInTransaction(logger),
    audit: auditFor(req, 'Undo of a bulk action within its undo window'),
    unblockEmailDomains: (domains, batchId) =>
      removeBlockedEmailDomains(
        req,
        domains,
        removed => `unblocked signups from ${removed.join(', ')} undoing bulk batch ${batchId}`
      ),
    logger,
  };
}
