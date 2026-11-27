import type { ISpendRollupRepository } from '@bike4mind/common';
import { Organization, User } from '@bike4mind/database';
import { resolvePaidScopes, type PaidScopeDeps } from './paidScopes';
import { scopeMapKey, type ResolveScopeDeps, type ScopeKey } from './resolveScope';

/**
 * How an account is funded, strongest signal first: an active paid subscription, an unreversed credit
 * purchase, a Stripe customer with neither, or nothing but granted (free) credits.
 */
export type AccountFunding = 'subscription' | 'purchase' | 'stripe_customer' | 'granted';

/** At-a-glance facts for one top-spending account, rendered on its line in a platform spend alarm. */
export type TopAccountContext = {
  kind: 'user' | 'org';
  adminPath: string;
  /** Age at the end of the evaluated window, or null when the record has no createdAt. */
  ageMs: number | null;
  creditBalance: number | null;
  funding: AccountFunding;
  /** The account's largest model in the window by credits, with its usage-row count. */
  topModel: { model: string; calls: number } | null;
};

export type TopAccountRecord = {
  id: string;
  createdAt?: Date | null;
  currentCredits?: number | null;
  stripeCustomerId?: string | null;
  lastCreditsPurchasedAt?: Date | null;
};

export type TopAccountContextDeps = {
  findUsers: (ids: readonly string[]) => Promise<readonly TopAccountRecord[]>;
  findOrganizations: (ids: readonly string[]) => Promise<readonly TopAccountRecord[]>;
};

type TopAccountKey = ScopeKey & { scopeType: 'User' | 'Organization' };

export type ResolveTopAccountContextDeps = {
  topAccountContextDeps: TopAccountContextDeps;
  rollups: Pick<ISpendRollupRepository, 'ownerModelActivity'>;
  resolveScopeDeps: ResolveScopeDeps;
  paidScopeDeps: PaidScopeDeps;
};

const userAdminPath = (id: string): string => `/admin/users/${id}`;
// Opens the organization profile modal on the admin Organizations tab.
const organizationAdminPath = (id: string): string => `/admin?tab=organizations&orgId=${id}`;

function fundingOf(record: TopAccountRecord, paid: boolean): AccountFunding {
  if (paid) return 'subscription';
  if (record.lastCreditsPurchasedAt) return 'purchase';
  if (record.stripeCustomerId) return 'stripe_customer';
  return 'granted';
}

const isTopAccountKey = (key: ScopeKey): key is TopAccountKey =>
  key.scopeType === 'User' || key.scopeType === 'Organization';

/**
 * One batched read per source (users, organizations, subscriptions, ledger) for all top accounts at
 * once, run in parallel. Accounts whose record is missing are left out. Throws on any failed read: the
 * caller falls back to the plain account lines.
 */
export async function resolveTopAccountContexts(
  keys: readonly ScopeKey[],
  window: { start: Date; end: Date },
  deps: ResolveTopAccountContextDeps
): Promise<Map<string, TopAccountContext>> {
  const accounts = keys.filter(isTopAccountKey);
  if (accounts.length === 0) return new Map();
  const idsOf = (scopeType: TopAccountKey['scopeType']) =>
    accounts.filter(key => key.scopeType === scopeType).map(key => key.scopeId);
  const userIds = idsOf('User');
  const organizationIds = idsOf('Organization');

  const [users, organizations, activity, paidKeys] = await Promise.all([
    userIds.length > 0 ? deps.topAccountContextDeps.findUsers(userIds) : [],
    organizationIds.length > 0 ? deps.topAccountContextDeps.findOrganizations(organizationIds) : [],
    deps.rollups.ownerModelActivity(window.start, window.end, accounts),
    resolvePaidScopes(accounts, deps.resolveScopeDeps, deps.paidScopeDeps),
  ]);

  const topModels = new Map<string, { model: string; calls: number; credits: number }>();
  for (const row of activity) {
    const key = scopeMapKey(row.scopeType, row.scopeId);
    const current = topModels.get(key);
    if (!current || row.credits > current.credits) {
      topModels.set(key, { model: row.model, calls: row.calls, credits: row.credits });
    }
  }

  const contexts = new Map<string, TopAccountContext>();
  const add = (scopeType: TopAccountKey['scopeType'], record: TopAccountRecord) => {
    const key = scopeMapKey(scopeType, record.id);
    const createdAt = record.createdAt ? new Date(record.createdAt).getTime() : NaN;
    const top = topModels.get(key);
    contexts.set(key, {
      kind: scopeType === 'User' ? 'user' : 'org',
      adminPath: scopeType === 'User' ? userAdminPath(record.id) : organizationAdminPath(record.id),
      ageMs: Number.isFinite(createdAt) ? Math.max(0, window.end.getTime() - createdAt) : null,
      creditBalance:
        typeof record.currentCredits === 'number' && Number.isFinite(record.currentCredits)
          ? record.currentCredits
          : null,
      funding: fundingOf(record, paidKeys.has(key)),
      topModel: top ? { model: top.model, calls: top.calls } : null,
    });
  };
  for (const user of users) add('User', user);
  for (const organization of organizations) add('Organization', organization);
  return contexts;
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;
const validObjectIds = (ids: readonly string[]): string[] => ids.filter(id => OBJECT_ID_PATTERN.test(id));

const ACCOUNT_FIELDS = 'createdAt currentCredits stripeCustomerId lastCreditsPurchasedAt';

type AccountRow = Omit<TopAccountRecord, 'id'> & { _id: unknown };

const toRecords = (rows: AccountRow[]): TopAccountRecord[] =>
  rows.map(({ _id, ...row }) => ({ ...row, id: String(_id) }));

export function defaultTopAccountContextDeps(): TopAccountContextDeps {
  return {
    findUsers: async ids => {
      const validIds = validObjectIds(ids);
      if (validIds.length === 0) return [];
      const rows = await User.find({ _id: { $in: validIds } })
        .select(ACCOUNT_FIELDS)
        .maxTimeMS(2000)
        .lean<AccountRow[]>();
      return toRecords(rows);
    },
    findOrganizations: async ids => {
      const validIds = validObjectIds(ids);
      if (validIds.length === 0) return [];
      const rows = await Organization.find({ _id: { $in: validIds } })
        .select(ACCOUNT_FIELDS)
        .maxTimeMS(2000)
        .lean<AccountRow[]>();
      return toRecords(rows);
    },
  };
}
