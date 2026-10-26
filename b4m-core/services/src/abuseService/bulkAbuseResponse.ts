import { createHash } from 'node:crypto';
import {
  ApiKeyStatus,
  BULK_ABUSE_SAMPLE_SIZE,
  CreditHolderType,
  MAX_BULK_ABUSE_BATCH,
  ORG_MEMBERSHIP_ACL_PERMISSIONS,
  isEmailInDomains,
  normalizeEmailDomain,
  type AdminAuditAction,
  type AuditChange,
  type BulkAbuseAction,
  type BulkAbuseActions,
  type BulkAbuseExclusion,
  type BulkAbuseExclusionReason,
  type BulkAbuseStepOutcome,
  type BulkAbuseTarget,
  type BulkAbuseUserResult,
  type BulkAbuseUserSummary,
  type IAuthSessionRepository,
  type ICreditTransactionRepository,
  type IOrganizationRepository,
  type IRealtimeConnectionRepository,
  type IUser,
  type IUserApiKeyRepository,
  type IUserRepository,
} from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { subtractCreditsWithLedgerRow } from '../creditService/subtractCredits';
import { endRealtimeConnections } from '../authSessionService/endRealtimeConnections';

export const ABUSE_CLAWBACK_REASON = 'abuse_clawback';

/** Ledger ids of the verified-email signup grant; must stay in sync with userService/freeCredits.ts. */
export const signupGrantTransactionIds = (userId: string): string[] => [
  `verify-grant:${userId}`,
  `otc-register-grant:${userId}`,
];

// Users run in parallel up to this many at a time; each holds its own transaction.
const EXECUTE_CONCURRENCY = 8;

type UserFinder = {
  find: (
    filter: Record<string, unknown>,
    options?: { limit?: number; sort?: Record<string, 1 | -1> }
  ) => Promise<IUser[]>;
};

export type BulkAbuseCohortAdapters = {
  db: {
    users: UserFinder;
    organizations: Pick<IOrganizationRepository, 'find'>;
    creditTransactions: Pick<ICreditTransactionRepository, 'find'>;
  };
};

export type BulkAbuseCohort = {
  included: IUser[];
  excluded: BulkAbuseExclusion[];
  hasMore: boolean;
  nextAfterUserId: string | null;
  /** Domain targets only: the newest user id considered. Execute re-resolves with the same bound. */
  upToUserId: string | null;
};

/**
 * The largest ObjectId that can have been minted by `at`, so a bound taken at preview time keeps
 * accounts created afterwards out of execute. Without it a farm still signing up changes every
 * re-resolved cohort and execute could never get past the fingerprint check.
 */
export function userIdUpperBound(at: Date): string {
  return (
    Math.floor(at.getTime() / 1000)
      .toString(16)
      .padStart(8, '0') + 'f'.repeat(16)
  );
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A dot, or the ideographic and fullwidth stops emailDomainOf reads as dots.
const DOT_CLASS = '[.\u3002\uff0e\uff61]';

function exclusionFor(user: IUser, actorId: string): BulkAbuseExclusionReason | null {
  if (user.id === actorId) return 'self';
  if (user.isAdmin) return 'admin';
  if (user.isSystem) return 'system';
  return isPaidAccount(user) ? 'paid' : null;
}

/** Any sign the account has paid, or is on a paid tier: such accounts are never bulk-actioned. */
export function isPaidAccount(user: IUser, now = new Date()): boolean {
  if (user.level !== 'DemoUser') return true;
  if (user.stripeCustomerId || user.lastCreditsPurchasedAt) return true;
  return user.subscribedUntil !== null && user.subscribedUntil !== undefined && new Date(user.subscribedUntil) > now;
}

async function findTargetUsers(
  target: BulkAbuseTarget,
  upToUserId: string,
  { db }: BulkAbuseCohortAdapters
): Promise<{ users: IUser[]; missingIds: string[]; hasMore: boolean; lastScannedId: string | null }> {
  if (target.kind === 'users') {
    const ids = [...new Set(target.userIds.map(id => id.toLowerCase()))];
    const users = await db.users.find({ _id: { $in: ids }, deletedAt: null });
    const found = new Set(users.map(user => user.id));
    return { users, missingIds: ids.filter(id => !found.has(id)), hasMore: false, lastScannedId: null };
  }

  const domain = normalizeEmailDomain(target.domain);
  if (!domain) throw new Error(`Not a valid domain: ${target.domain}`);
  // The domain itself or any subdomain: `@kashre.com` and `@np.kashre.com`, never `@notkashre.com`.
  // The unanchored, case-insensitive regex cannot use an index and scans users; a stored normalized
  // emailDomain field with an index would fix that. The JS re-check below is the exact filter.
  const domainPattern = escapeRegExp(domain).replaceAll('\\.', DOT_CLASS);
  const filter: Record<string, unknown> = {
    email: { $regex: `@(?:[^@]+${DOT_CLASS})?${domainPattern}${DOT_CLASS}*$`, $options: 'i' },
    deletedAt: null,
    _id: target.afterUserId ? { $gt: target.afterUserId, $lte: upToUserId } : { $lte: upToUserId },
  };
  const page = await db.users.find(filter, { sort: { _id: 1 }, limit: MAX_BULK_ABUSE_BATCH + 1 });
  const scanned = page.slice(0, MAX_BULK_ABUSE_BATCH);
  const domains = new Set([domain]);
  const users = scanned.filter(user => user.email && isEmailInDomains(user.email, domains));
  // The cursor is the last row scanned, not the last match, so rows the JS re-check drops still advance it.
  return {
    users,
    missingIds: [],
    hasMore: page.length > MAX_BULK_ABUSE_BATCH,
    lastScannedId: scanned.at(-1)?.id ?? null,
  };
}

async function orgOwnerIds(userIds: string[], { db }: BulkAbuseCohortAdapters): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const orgs = await db.organizations.find({ $or: [{ userId: { $in: userIds } }, { adminUserIds: { $in: userIds } }] });
  const candidates = new Set(userIds);
  const owners = new Set<string>();
  for (const org of orgs) {
    for (const id of [org.userId, ...(org.adminUserIds ?? [])]) if (id && candidates.has(id)) owners.add(id);
  }
  return owners;
}

/** Seat members of any organization: a users[] ACL row with member permissions (the org membership rule). */
async function orgMemberIds(userIds: string[], { db }: BulkAbuseCohortAdapters): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const memberPermissions: readonly string[] = ORG_MEMBERSHIP_ACL_PERMISSIONS;
  const orgs = await db.organizations.find({
    users: { $elemMatch: { userId: { $in: userIds }, permissions: { $in: [...memberPermissions] } } },
  });
  const candidates = new Set(userIds);
  const members = new Set<string>();
  for (const org of orgs) {
    for (const row of org.users ?? []) {
      if (candidates.has(row.userId) && row.permissions?.some(permission => memberPermissions.includes(permission))) {
        members.add(row.userId);
      }
    }
  }
  return members;
}

async function purchaserIds(userIds: string[], { db }: BulkAbuseCohortAdapters): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.creditTransactions.find({
    ownerId: { $in: userIds },
    ownerType: CreditHolderType.User,
    type: { $in: ['purchase', 'subscription'] },
  });
  return new Set(rows.map(row => row.ownerId));
}

/**
 * The users a bulk action would touch, and the ones it skips with why. Admins, system accounts,
 * org owners, managers and members, paid accounts and the acting admin are never actioned. A domain target
 * returns at most MAX_BULK_ABUSE_BATCH users in id order, with a cursor for the rest. Pass the
 * preview's `upToUserId` back on execute so both resolve the same users.
 */
export async function resolveBulkAbuseCohort(
  target: BulkAbuseTarget,
  actorId: string,
  adapters: BulkAbuseCohortAdapters,
  options: { upToUserId?: string } = {}
): Promise<BulkAbuseCohort> {
  const upToUserId = options.upToUserId ?? userIdUpperBound(new Date());
  const { users, missingIds, hasMore, lastScannedId } = await findTargetUsers(target, upToUserId, adapters);
  const excluded: BulkAbuseExclusion[] = missingIds.map(userId => ({ userId, email: null, reason: 'not_found' }));

  const candidates: IUser[] = [];
  for (const user of users) {
    const reason = exclusionFor(user, actorId);
    if (reason) excluded.push({ userId: user.id, email: user.email, reason });
    else candidates.push(user);
  }

  const candidateIds = candidates.map(user => user.id);
  const [owners, purchasers, members] = await Promise.all([
    orgOwnerIds(candidateIds, adapters),
    purchaserIds(candidateIds, adapters),
    orgMemberIds(candidateIds, adapters),
  ]);
  const included: IUser[] = [];
  for (const user of candidates) {
    if (owners.has(user.id)) excluded.push({ userId: user.id, email: user.email, reason: 'org_owner' });
    else if (purchasers.has(user.id)) excluded.push({ userId: user.id, email: user.email, reason: 'paid' });
    else if (user.organizationId || members.has(user.id)) {
      excluded.push({ userId: user.id, email: user.email, reason: 'org_member' });
    } else included.push(user);
  }

  return {
    included,
    excluded,
    hasMore,
    nextAfterUserId: hasMore ? lastScannedId : null,
    upToUserId: target.kind === 'domain' ? upToUserId : null,
  };
}

/**
 * Binds a preview to what it showed: the target, the actions and the exact users included. Execute
 * recomputes it from a fresh resolve, so a cohort that changed since the preview is refused.
 */
export function bulkAbuseFingerprint(
  target: BulkAbuseTarget,
  actions: BulkAbuseActions,
  includedIds: string[]
): string {
  const canonicalTarget =
    target.kind === 'domain'
      ? { kind: 'domain', domain: normalizeEmailDomain(target.domain), afterUserId: target.afterUserId ?? null }
      : { kind: 'users', userIds: [...new Set(target.userIds.map(id => id.toLowerCase()))].sort() };
  const canonicalActions = {
    ban: actions.ban,
    revokeApiKeys: actions.revokeApiKeys,
    revokeSessions: actions.revokeSessions,
    clawbackFreeCredits: actions.clawbackFreeCredits,
  };
  const payload = JSON.stringify({
    target: canonicalTarget,
    actions: canonicalActions,
    users: [...includedIds].sort(),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export type BulkAbusePreviewAdapters = {
  db: {
    userApiKeys: Pick<IUserApiKeyRepository, 'count'>;
    creditTransactions: Pick<ICreditTransactionRepository, 'find'>;
  };
};

export type BulkAbusePreviewCounts = {
  sample: BulkAbuseUserSummary[];
  alreadyBannedCount: number;
  activeApiKeyCount: number;
  clawbackCredits: number;
};

const toSummary = (user: IUser): BulkAbuseUserSummary => ({
  id: user.id,
  email: user.email,
  username: user.username,
  isBanned: user.isBanned,
  currentCredits: user.currentCredits,
});

/** Signup grant credits per user, keyed by owner id. */
async function signupGrants(
  userIds: string[],
  { db }: { db: { creditTransactions: Pick<ICreditTransactionRepository, 'find'> } }
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.creditTransactions.find({ transactionId: { $in: userIds.flatMap(signupGrantTransactionIds) } });
  const grants = new Map<string, number>();
  for (const row of rows) grants.set(row.ownerId, Math.max(grants.get(row.ownerId) ?? 0, row.credits));
  return grants;
}

async function priorClawbackIds(
  userIds: string[],
  { db }: { db: { creditTransactions: Pick<ICreditTransactionRepository, 'find'> } }
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db.creditTransactions.find({
    ownerId: { $in: userIds },
    type: 'generic_deduct',
    reason: ABUSE_CLAWBACK_REASON,
  });
  return new Set(rows.map(row => row.ownerId));
}

/** The credits a clawback removes: the unspent part of the signup grant, never below zero. */
export const clawbackAmount = (currentCredits: number, grantCredits: number): number =>
  Math.max(0, Math.min(currentCredits, grantCredits));

/** The keys deactivateAllByUserId disables, so the preview counts what execute revokes. */
const liveApiKeysFilter = (userId: string | { $in: string[] }) => ({ userId, status: { $ne: ApiKeyStatus.DISABLED } });

/** What executing would change for the included users, for the confirmation dialog. */
export async function previewBulkAbuseCounts(
  included: IUser[],
  adapters: BulkAbusePreviewAdapters
): Promise<BulkAbusePreviewCounts> {
  const ids = included.map(user => user.id);
  const [activeApiKeyCount, grants, clawedBack] = await Promise.all([
    ids.length > 0 ? adapters.db.userApiKeys.count(liveApiKeysFilter({ $in: ids })) : 0,
    signupGrants(ids, adapters),
    priorClawbackIds(ids, adapters),
  ]);
  const clawbackCredits = included.reduce(
    (sum, user) =>
      clawedBack.has(user.id) ? sum : sum + clawbackAmount(user.currentCredits, grants.get(user.id) ?? 0),
    0
  );
  return {
    sample: included.slice(0, BULK_ABUSE_SAMPLE_SIZE).map(toSummary),
    alreadyBannedCount: included.filter(user => user.isBanned).length,
    activeApiKeyCount,
    clawbackCredits,
  };
}

export type BulkAbuseAuditEntry = {
  action: Extract<AdminAuditAction, `abuse.bulk.${string}`>;
  user: Pick<IUser, 'id' | 'email' | 'username'>;
  summary: string;
  changes?: AuditChange[];
  details?: Record<string, unknown>;
  related?: { creditTransactionId?: string };
};

type TrustedDeviceRevoker = { revokeAllForUser: (userId: string) => Promise<number> };

export type BulkAbuseExecuteAdapters = {
  db: {
    users: Pick<IUserRepository, 'findById' | 'update' | 'incrementTokenVersion' | 'incrementCredits'>;
    userApiKeys: Pick<IUserApiKeyRepository, 'count' | 'deactivateAllByUserId'>;
    authSessions: Pick<IAuthSessionRepository, 'revokeAllByUserId'>;
    realtimeConnections: Pick<IRealtimeConnectionRepository, 'endConnections'>;
    trustedDevices: TrustedDeviceRevoker;
    creditTransactions: ICreditTransactionRepository;
  };
  /** Runs one user's steps atomically; may retry the callback, so every step re-reads its state. */
  withTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
  /** A strict audit write; called inside the user's transaction so the entry and the step commit together. */
  audit: (entry: BulkAbuseAuditEntry) => Promise<unknown>;
  logger?: Logger;
};

type StepResult = { outcome: BulkAbuseStepOutcome; revokedApiKeys?: number; clawedBackCredits?: number };

async function banStep(user: IUser, { db, audit }: BulkAbuseExecuteAdapters): Promise<StepResult> {
  const current = await db.users.findById(user.id);
  if (!current || current.isBanned) return { outcome: 'skipped' };
  await db.users.update({ id: user.id, isBanned: true });
  await audit({
    action: 'abuse.bulk.ban',
    user,
    summary: 'banned in a bulk abuse response',
    changes: [{ field: 'isBanned', before: false, after: true }],
  });
  return { outcome: 'applied' };
}

async function revokeKeysStep(user: IUser, { db, audit }: BulkAbuseExecuteAdapters): Promise<StepResult> {
  const live = await db.userApiKeys.count(liveApiKeysFilter(user.id));
  if (live === 0) return { outcome: 'skipped', revokedApiKeys: 0 };
  await db.userApiKeys.deactivateAllByUserId(user.id);
  await audit({
    action: 'abuse.bulk.revoke_keys',
    user,
    summary: `revoked ${live} API key(s) in a bulk abuse response`,
    details: { revokedApiKeys: live },
  });
  return { outcome: 'applied', revokedApiKeys: live };
}

async function revokeSessionsStep(user: IUser, { db, audit }: BulkAbuseExecuteAdapters): Promise<StepResult> {
  const revokedSessions = await db.authSessions.revokeAllByUserId(user.id);
  const trustedDevices = await db.trustedDevices.revokeAllForUser(user.id);
  // Bump unconditionally: legacy JWT refresh/access tokens have no AuthSession row and are gated only by
  // tokenVersion. Only the audit row and the applied outcome depend on something having been revoked.
  await db.users.incrementTokenVersion(user.id);
  if (revokedSessions === 0 && trustedDevices === 0) return { outcome: 'skipped' };
  await audit({
    action: 'abuse.bulk.revoke_sessions',
    user,
    summary: 'revoked all sessions in a bulk abuse response',
    details: { sessionsRevoked: revokedSessions, trustedDevicesRevoked: trustedDevices },
  });
  return { outcome: 'applied' };
}

async function clawbackStep(user: IUser, actorId: string, adapters: BulkAbuseExecuteAdapters): Promise<StepResult> {
  const { db, audit } = adapters;
  // Re-read inside the transaction: a retry or a concurrent run must see the prior clawback row. Two
  // runs on one user both write the user document, so the second's transaction conflicts and retries.
  // Sequential, because one session cannot run operations concurrently inside a transaction.
  const prior = await priorClawbackIds([user.id], adapters);
  const grants = await signupGrants([user.id], adapters);
  const current = await db.users.findById(user.id);
  if (prior.has(user.id) || !current) return { outcome: 'skipped', clawedBackCredits: 0 };
  const grantCredits = grants.get(user.id) ?? 0;
  const credits = clawbackAmount(current.currentCredits, grantCredits);
  if (credits === 0) return { outcome: 'skipped', clawedBackCredits: 0 };

  const { creditTransactionId } = await subtractCreditsWithLedgerRow(
    {
      ownerId: user.id,
      ownerType: CreditHolderType.User,
      credits,
      type: 'generic_deduct',
      reason: ABUSE_CLAWBACK_REASON,
      description: 'Unspent signup credits recovered in a bulk abuse response',
      metadata: { actorId, previousBalance: current.currentCredits, grantCredits },
    },
    { db: { creditTransactions: db.creditTransactions }, creditHolderMethods: db.users }
  );
  await audit({
    action: 'abuse.bulk.clawback',
    user,
    summary: `clawed back ${credits} unspent signup credit(s) in a bulk abuse response`,
    details: { credits: -credits, previousBalance: current.currentCredits, grantCredits },
    related: creditTransactionId ? { creditTransactionId } : undefined,
  });
  return { outcome: 'applied', clawedBackCredits: credits };
}

const NOT_REQUESTED: StepResult = { outcome: 'not_requested' };

/** A ban always revokes API keys too, so lifting it later never re-enables old keys. */
const withBanImpliedKeyRevoke = (actions: BulkAbuseActions): BulkAbuseActions => ({
  ...actions,
  revokeApiKeys: actions.revokeApiKeys || actions.ban,
});

async function executeForUser(
  user: IUser,
  requested: BulkAbuseActions,
  actorId: string,
  adapters: BulkAbuseExecuteAdapters
): Promise<BulkAbuseUserResult> {
  const actions = withBanImpliedKeyRevoke(requested);
  try {
    const steps = await adapters.withTransaction(async () => {
      const ban = actions.ban ? await banStep(user, adapters) : NOT_REQUESTED;
      const revokeApiKeys = actions.revokeApiKeys ? await revokeKeysStep(user, adapters) : NOT_REQUESTED;
      const revokeSessions = actions.revokeSessions ? await revokeSessionsStep(user, adapters) : NOT_REQUESTED;
      const clawbackFreeCredits = actions.clawbackFreeCredits
        ? await clawbackStep(user, actorId, adapters)
        : NOT_REQUESTED;
      return { ban, revokeApiKeys, revokeSessions, clawbackFreeCredits } satisfies Record<BulkAbuseAction, StepResult>;
    });
    // Sockets end now rather than at their next auth check: all of them for a ban or revoked key,
    // the session-authenticated ones for revoked sessions. Runs after the commit so a rollback never
    // ends sockets for a revoke that did not stick. See endRealtimeConnections.ts.
    const endFilter =
      steps.ban.outcome === 'applied' || steps.revokeApiKeys.outcome === 'applied'
        ? { userId: user.id }
        : steps.revokeSessions.outcome === 'applied'
          ? { userId: user.id, sessionsOnly: true }
          : null;
    if (endFilter) await endRealtimeConnections(endFilter, { db: adapters.db, logger: adapters.logger });
    return {
      userId: user.id,
      email: user.email,
      status: 'succeeded',
      steps: {
        ban: steps.ban.outcome,
        revokeApiKeys: steps.revokeApiKeys.outcome,
        revokeSessions: steps.revokeSessions.outcome,
        clawbackFreeCredits: steps.clawbackFreeCredits.outcome,
      },
      revokedApiKeys: steps.revokeApiKeys.revokedApiKeys ?? 0,
      clawedBackCredits: steps.clawbackFreeCredits.clawedBackCredits ?? 0,
    };
  } catch (error) {
    adapters.logger?.error('Bulk abuse response failed for user', user.id, error);
    return {
      userId: user.id,
      email: user.email,
      status: 'failed',
      steps: { ban: 'skipped', revokeApiKeys: 'skipped', revokeSessions: 'skipped', clawbackFreeCredits: 'skipped' },
      revokedApiKeys: 0,
      clawedBackCredits: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Applies the selected actions to each included user. Each user is one transaction, so a failure
 * rolls back only that user and is reported; the rest continue. Every step is idempotent, so a
 * re-run over the same cohort skips what was already done.
 */
export async function executeBulkAbuse(
  included: IUser[],
  actions: BulkAbuseActions,
  actorId: string,
  adapters: BulkAbuseExecuteAdapters
): Promise<BulkAbuseUserResult[]> {
  const results: BulkAbuseUserResult[] = [];
  for (let start = 0; start < included.length; start += EXECUTE_CONCURRENCY) {
    const chunk = included.slice(start, start + EXECUTE_CONCURRENCY);
    results.push(...(await Promise.all(chunk.map(user => executeForUser(user, actions, actorId, adapters)))));
  }
  return results;
}
