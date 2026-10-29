import { createHash } from 'node:crypto';
import type { UserModerationStatus } from '@bike4mind/common';
import {
  ADMIN_USERS_BULK_MAX,
  ADMIN_USERS_BULK_MAX_CREDIT_TOTAL,
  type AdminUsersBulkAction,
  type AdminUsersBulkPreview,
  type AdminUsersBulkTarget,
  blocksEmailDomains,
} from '@client/app/utils/adminUsersBulk';
import type { AdminUsersFilter } from '@client/app/utils/adminUsersFilter';
import { planEmailDomains } from './emailDomains';

/** The user fields a bulk action reads; resolve projects only these. */
export type BulkUser = {
  id: string;
  name: string | null;
  email: string | null;
  username: string | null;
  isAdmin: boolean;
  isBanned: boolean;
  isModerated: boolean;
  tags: string[];
  currentCredits: number;
  /** Block state besides isBanned, read so undo never re-enables keys of an otherwise blocked account. */
  disputePending: boolean;
  moderationStatus: UserModerationStatus | null;
};

/** Reads one page of filter matches in `_id` order, strictly after `afterId`. */
export type FilterPageReader = (afterId: string | null, limit: number) => Promise<BulkUser[]>;

export type ResolveDeps = {
  findUsersByIds: (ids: string[]) => Promise<BulkUser[]>;
  openFilterPages: (filter: AdminUsersFilter, now: Date) => Promise<FilterPageReader>;
};

export type ResolvedCohort = {
  matched: number;
  eligible: BulkUser[];
  excluded: { self: number; admins: number };
  /** More than ADMIN_USERS_BULK_MAX eligible, or too many matches to tell: execute refuses it. */
  overCap: boolean;
};

export const RESOLVE_PAGE_SIZE = 200;
/**
 * Hard bound on filter pages read. Enough for the cap plus a page of excluded admins; a filter that
 * still has rows after this many pages is reported as over the cap instead of being read further.
 */
export const RESOLVE_MAX_PAGES = Math.ceil((ADMIN_USERS_BULK_MAX + 1) / RESOLVE_PAGE_SIZE) + 2;

const SAMPLE_SIZE = 5;

type Classified = { eligible: BulkUser[]; excluded: { self: number; admins: number } };

function classify(users: BulkUser[], selfIds: ReadonlySet<string>, into: Classified): void {
  for (const user of users) {
    if (selfIds.has(user.id)) into.excluded.self += 1;
    else if (user.isAdmin) into.excluded.admins += 1;
    else into.eligible.push(user);
  }
}

/**
 * The users a bulk action targets, minus the calling admin (and the account they impersonate) and
 * every admin. A filter target is read in `_id` pages and stops as soon as the cap is exceeded, so
 * resolving never reads more than RESOLVE_MAX_PAGES pages.
 */
export async function resolveAdminUsersBulk(
  target: AdminUsersBulkTarget,
  selfIds: readonly string[],
  deps: ResolveDeps,
  now: Date
): Promise<ResolvedCohort> {
  const self = new Set(selfIds.map(id => id.toLowerCase()));
  const result: Classified = { eligible: [], excluded: { self: 0, admins: 0 } };

  if (target.kind === 'ids') {
    const users = await deps.findUsersByIds([...new Set(target.userIds)]);
    classify(users, self, result);
    return { matched: users.length, ...result, overCap: result.eligible.length > ADMIN_USERS_BULK_MAX };
  }

  const readPage = await deps.openFilterPages(target.filter, now);
  let matched = 0;
  let afterId: string | null = null;
  let exhausted = false;
  for (let page = 0; page < RESOLVE_MAX_PAGES; page++) {
    const rows = await readPage(afterId, RESOLVE_PAGE_SIZE);
    matched += rows.length;
    classify(rows, self, result);
    if (rows.length < RESOLVE_PAGE_SIZE) {
      exhausted = true;
      break;
    }
    if (result.eligible.length > ADMIN_USERS_BULK_MAX) break;
    afterId = rows[rows.length - 1].id;
  }
  return { matched, ...result, overCap: !exhausted || result.eligible.length > ADMIN_USERS_BULK_MAX };
}

/**
 * Signed balance change the action makes for one user. A deduction never takes a balance below
 * zero; `set` and `contain` land the balance exactly on the target.
 */
export function creditDeltaFor(action: AdminUsersBulkAction, balance: number): number {
  return signedDelta(action, balance) || 0; // normalizes -0, which would leak into JSON and equality checks
}

function signedDelta(action: AdminUsersBulkAction, balance: number): number {
  if (action.type === 'contain') return -Math.max(0, balance);
  if (action.type !== 'adjustCredits') return 0;
  if (action.mode === 'add') return action.amount;
  if (action.mode === 'subtract') return -Math.min(action.amount, Math.max(0, balance));
  return action.amount - balance;
}

/** Whether the action disables the user's live keys (suspend does, as a ban always has). */
export function revokesKeys(action: AdminUsersBulkAction, user: Pick<BulkUser, 'isBanned'>): boolean {
  if (action.type === 'revokeApiKeys' || action.type === 'contain') return true;
  return action.type === 'suspend' && !user.isBanned;
}

/** True when the action would change nothing for this user; such users are skipped. */
export function isAlreadyApplied(action: AdminUsersBulkAction, user: BulkUser, liveKeys: number): boolean {
  switch (action.type) {
    case 'suspend':
      return user.isBanned;
    case 'restrict':
      return user.isModerated;
    case 'adjustCredits':
      return creditDeltaFor(action, user.currentCredits) === 0;
    case 'revokeApiKeys':
      return liveKeys === 0;
    case 'addTag':
      return user.tags.includes(action.tag);
    case 'contain':
      return user.isBanned && creditDeltaFor(action, user.currentCredits) === 0 && liveKeys === 0;
  }
}

/** Binds a confirmation to the exact users shown: sha256 of the sorted eligible ids. */
export function cohortHashOf(users: readonly Pick<BulkUser, 'id'>[]): string {
  const ids = users.map(user => user.id).sort();
  return createHash('sha256').update(ids.join(',')).digest('hex');
}

/** Net credits the action adds across these users, as planned from their current balances. */
export function netCreditsAdded(action: AdminUsersBulkAction, users: readonly BulkUser[]): number {
  return users.reduce((sum, user) => sum + creditDeltaFor(action, user.currentCredits), 0);
}

export const exceedsCreditTotal = (netAdded: number) => netAdded > ADMIN_USERS_BULK_MAX_CREDIT_TOTAL;

export type PreviewDeps = {
  /** Keys that still authenticate (status not DISABLED), per user id. */
  countLiveApiKeys: (userIds: string[]) => Promise<Map<string, number>>;
  /** The blockedEmailDomains list, normalized; read only when the action blocks domains. */
  blockedEmailDomains: () => Promise<ReadonlySet<string>>;
};

/** The confirmation-dialog numbers for a resolved cohort. Reads only; writes nothing. */
export async function previewAdminUsersBulk(
  cohort: ResolvedCohort,
  action: AdminUsersBulkAction,
  deps: PreviewDeps
): Promise<AdminUsersBulkPreview> {
  const users = cohort.eligible;
  const liveKeys = users.length > 0 ? await deps.countLiveApiKeys(users.map(user => user.id)) : new Map();
  let alreadyApplied = 0;
  let apiKeysToRevoke = 0;
  let creditsAdded = 0;
  for (const user of users) {
    const keys = liveKeys.get(user.id) ?? 0;
    if (isAlreadyApplied(action, user, keys)) {
      alreadyApplied += 1;
      continue;
    }
    if (revokesKeys(action, user)) apiKeysToRevoke += keys;
    creditsAdded += creditDeltaFor(action, user.currentCredits);
  }
  return {
    matched: cohort.matched,
    eligible: users.length,
    excluded: cohort.excluded,
    alreadyApplied,
    overCap: cohort.overCap,
    apiKeysToRevoke,
    // The contract reports removal as positive.
    creditsDelta: 0 - creditsAdded,
    creditsOverCap: exceedsCreditTotal(netCreditsAdded(action, users)),
    cohortHash: cohortHashOf(users),
    // Over every eligible user, already contained or not: their domains are still blocked.
    emailDomains: blocksEmailDomains(action) ? planEmailDomains(users, await deps.blockedEmailDomains()) : null,
    sample: users.slice(0, SAMPLE_SIZE).map(user => ({ id: user.id, name: user.name, email: user.email })),
  };
}
