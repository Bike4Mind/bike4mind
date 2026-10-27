import { ApiKeyStatus } from '@bike4mind/common';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import {
  RISK_BAND,
  SIGNED_UP_WINDOW_MS,
  type AdminUsersFilter,
  type AdminUsersSortField,
} from '@client/app/utils/adminUsersFilter';

type Condition = Record<string, unknown>;
type Stage = Record<string, unknown>;

/** Organization filter values that are not organization names. */
export const ALL_ORGANIZATIONS = 'all';
export const UNASSIGNED_ORGANIZATION = 'Unassigned';

/** The organization names a filter names, or null when it does not narrow by organization. */
export function organizationNamesOf(filter: AdminUsersFilter): string[] | null {
  const names = filter.orgSearch ?? [];
  if (names.length === 0 || names.includes(ALL_ORGANIZATIONS)) return null;
  return names.filter(name => name !== UNASSIGNED_ORGANIZATION);
}

const OBJECT_ID = /^[0-9a-f]{24}$/i;

function searchCondition(search: string, toObjectId: (id: string) => unknown): Condition {
  const pattern = escapeRegex(search);
  return {
    $or: [
      { name: { $regex: pattern, $options: 'i' } },
      { username: { $regex: pattern, $options: 'i' } },
      { email: { $regex: pattern, $options: 'i' } },
      ...(OBJECT_ID.test(search) ? [{ _id: toObjectId(search) }] : []),
    ],
  };
}

function tagsCondition(tags: string[]): Condition | null {
  // 'Admin' is the list's name for the isAdmin flag, not a stored tag (as in GET /api/users).
  const others = tags.filter(tag => tag !== 'Admin');
  const branches: Condition[] = [
    ...(tags.includes('Admin') ? [{ isAdmin: true }] : []),
    ...(others.length > 0 ? [{ tags: { $in: others } }] : []),
  ];
  if (branches.length === 0) return null;
  return branches.length === 1 ? branches[0] : { $or: branches };
}

const STATUS_CONDITIONS: Record<NonNullable<AdminUsersFilter['status']>, Condition> = {
  active: { isBanned: { $ne: true }, isModerated: { $ne: true } },
  suspended: { isBanned: true },
  restricted: { isModerated: true, isBanned: { $ne: true } },
};

export type AdminUsersQueryContext = {
  now: Date;
  /** Ids of the organizations `orgSearch` names, resolved by the caller. */
  organizationIds: unknown[];
  toObjectId: (id: string) => unknown;
};

/**
 * The `$match` for a filter. Every condition is on a User field, so it also serves `find()` callers;
 * only `hasApiKey` needs the extra stages from `apiKeyStages`.
 */
export function buildAdminUsersMatch(filter: AdminUsersFilter, context: AdminUsersQueryContext): Condition {
  const conditions: Condition[] = [];
  if (filter.search) conditions.push(searchCondition(filter.search, context.toObjectId));
  const tags = filter.tags && tagsCondition(filter.tags);
  if (tags) conditions.push(tags);

  const organizationNames = organizationNamesOf(filter);
  if (organizationNames) {
    conditions.push({
      $or: [
        { organizationId: { $in: context.organizationIds } },
        ...(filter.orgSearch?.includes(UNASSIGNED_ORGANIZATION) ? [{ organizationId: null }] : []),
      ],
    });
  }
  if (filter.status) conditions.push(STATUS_CONDITIONS[filter.status]);
  if (filter.plan) conditions.push({ level: filter.plan });
  if (filter.emailDomain) {
    // The domain or a subdomain of it: `@mail.example.com` matches example.com, `@notexample.com` does not.
    conditions.push({ email: { $regex: `@(?:[^@]+\\.)?${escapeRegex(filter.emailDomain)}$`, $options: 'i' } });
  }
  if (filter.signupMethod === 'email') {
    conditions.push({ $or: [{ authProviders: { $exists: false } }, { authProviders: { $size: 0 } }] });
  } else if (filter.signupMethod) {
    conditions.push({ 'authProviders.strategy': filter.signupMethod });
  }
  if (filter.verified) conditions.push({ emailVerified: filter.verified === 'yes' ? true : { $ne: true } });
  if (filter.signedUp) {
    conditions.push({ createdAt: { $gte: new Date(context.now.getTime() - SIGNED_UP_WINDOW_MS[filter.signedUp]) } });
  }
  if (filter.createdFrom || filter.createdTo) {
    conditions.push({
      createdAt: {
        ...(filter.createdFrom && { $gte: new Date(filter.createdFrom) }),
        ...(filter.createdTo && { $lt: new Date(filter.createdTo) }),
      },
    });
  }
  if (filter.risk) conditions.push({ 'signupGrantAssessment.band': RISK_BAND[filter.risk] });
  return conditions.length > 0 ? { $and: conditions } : {};
}

/** Keys that still authenticate or could again: the set a revoke disables (see bulkAbuseResponse.ts). */
export const LIVE_API_KEY_STATUS = { $ne: ApiKeyStatus.DISABLED };

/**
 * Stages narrowing to users with (or without) a live API key. Key rows store `userId` as a string.
 * `apiKeysCollection` is the UserApiKey model's collection name.
 */
export function apiKeyStages(filter: AdminUsersFilter, apiKeysCollection: string): Stage[] {
  if (!filter.hasApiKey) return [];
  return [
    {
      $lookup: {
        from: apiKeysCollection,
        let: { userId: { $toString: '$_id' } },
        pipeline: [
          { $match: { $expr: { $eq: ['$userId', '$$userId'] }, status: LIVE_API_KEY_STATUS } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'liveApiKey',
      },
    },
    { $match: { liveApiKey: filter.hasApiKey === 'yes' ? { $ne: [] } : { $eq: [] } } },
    { $project: { liveApiKey: 0 } },
  ];
}

/** `_id` breaks ties so pages never repeat or skip rows that share a sort value. */
export function adminUsersSort(field: AdminUsersSortField, order: 'asc' | 'desc'): Record<string, 1 | -1> {
  const direction = order === 'asc' ? 1 : -1;
  return { [field]: direction, _id: direction };
}
