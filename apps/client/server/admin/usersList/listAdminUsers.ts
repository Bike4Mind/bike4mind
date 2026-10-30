import { AI_USAGE_TRANSACTION_TYPES, CreditHolderType } from '@bike4mind/common';
import {
  AnalyticsUserDay,
  CreditTransaction,
  Organization,
  User,
  UserApiKey,
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  mongoose,
  type IUserObject,
} from '@bike4mind/database';
import { ADMIN_USER_PROJECTION, type AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type {
  AdminUsersFilter,
  AdminUsersListParams,
  AdminUsersListResponse,
  AdminUsersSummary,
} from '@client/app/utils/adminUsersFilter';
import { withSafeOrganization } from '@server/utils/toSafeOrganizationSubdocument';
import { getDomainGroups, SIGNUP_SCAN_LIMIT } from '@server/users/signupAnomaly';
import { funnelStepUserIds } from '@server/analytics/activationFunnel';
import { signupVerdictUserIds } from '@server/analytics/signupCohort';
import { LIVE_API_KEY_STATUS, adminUsersSort, buildAdminUsersMatch, organizationNamesOf } from './adminUsersQuery';

// ms. A list read that runs past this is a filter the indexes cannot serve; fail it rather than queue.
const LIST_MAX_TIME_MS = 10_000;
const SPEND_WINDOW_MS = 30 * 86_400_000;

const toObjectId = (id: string) => new mongoose.Types.ObjectId(id);

/** The created window `verdict` and `funnelStep` classify; the filter schema requires both ends with them. */
function cohortWindow(filter: AdminUsersFilter, key: 'verdict' | 'funnelStep') {
  if (!filter.createdFrom || !filter.createdTo) throw new Error(`${key} needs createdFrom and createdTo`);
  return { start: new Date(filter.createdFrom), end: new Date(filter.createdTo) };
}

/** Users with a rolled-up day of AI activity in [fromDay, toDay], served by the { day, userId } index. */
async function activeUserIds(fromDay: string, toDay: string): Promise<string[]> {
  const rows = await AnalyticsUserDay.aggregate<{ _id: string }>([
    { $match: { day: { $gte: fromDay, $lte: toDay } } },
    { $group: { _id: '$userId' } },
  ]).option({ maxTimeMS: LIST_MAX_TIME_MS });
  return rows.map(row => row._id);
}

/**
 * The filter as a single leading `$match`, with organization names, live-key holders and the analytics
 * cohorts (verdict, active window, funnel step) resolved to ids. The list, export, domain groups and the
 * bulk resolver all start here, so one filter always selects the same users.
 */
export async function adminUsersPipeline(
  filter: AdminUsersFilter,
  now = new Date()
): Promise<mongoose.PipelineStage[]> {
  const names = organizationNamesOf(filter);
  const organizationIds =
    names && names.length > 0
      ? (
          await Organization.find({ name: { $in: names } })
            .select('_id')
            .lean()
        ).map(org => org._id)
      : [];
  // Key rows store userId as a string. One id per keyed user, which stays far below the 16 MB result cap.
  const liveApiKeyUserIds = filter.hasApiKey
    ? ((await UserApiKey.distinct('userId', { status: LIVE_API_KEY_STATUS })) as unknown[]).map(String)
    : undefined;
  const cohortOptions = { now, deadlineMs: LIST_MAX_TIME_MS };
  const [verdictUserIds, activeIds, funnelIds] = await Promise.all([
    filter.verdict
      ? signupVerdictUserIds({ ...cohortWindow(filter, 'verdict'), verdict: filter.verdict }, cohortOptions)
      : undefined,
    filter.activeFrom && filter.activeTo ? activeUserIds(filter.activeFrom, filter.activeTo) : undefined,
    filter.funnelStep
      ? funnelStepUserIds({ ...cohortWindow(filter, 'funnelStep'), step: filter.funnelStep }, cohortOptions)
      : undefined,
  ]);
  const match = buildAdminUsersMatch(filter, {
    now,
    organizationIds,
    toObjectId,
    liveApiKeyUserIds,
    verdictUserIds,
    activeUserIds: activeIds,
    funnelStepUserIds: funnelIds,
  });
  // adminUsersQuery builds plain objects so it stays mongoose-free and unit-testable.
  return [{ $match: match }] as unknown as mongoose.PipelineStage[];
}

async function liveApiKeyCounts(userIds: string[]): Promise<Map<string, number>> {
  const rows: { _id: string; count: number }[] = await UserApiKey.aggregate([
    { $match: { userId: { $in: userIds }, status: LIVE_API_KEY_STATUS } },
    { $group: { _id: '$userId', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map(row => [row._id, row.count]));
}

/** AI usage over the last 30 days, bounded to one page of users so it never scans the whole ledger. */
async function spendLast30Days(userIds: string[], now: Date): Promise<Map<string, number>> {
  const rows: { _id: string; credits: number }[] = await CreditTransaction.aggregate([
    {
      $match: {
        ownerId: { $in: userIds },
        ownerType: CreditHolderType.User,
        createdAt: { $gte: new Date(now.getTime() - SPEND_WINDOW_MS) },
        type: { $in: AI_USAGE_TRANSACTION_TYPES },
      },
    },
    { $group: { _id: '$ownerId', credits: { $sum: { $abs: '$credits' } } } },
  ]);
  return new Map(rows.map(row => [row._id, row.credits]));
}

export async function listAdminUsers(
  params: AdminUsersListParams,
  viewer: { userId: string; isAdmin: boolean },
  options: { logError: (message: string, error: unknown) => void },
  now = new Date()
): Promise<AdminUsersListResponse> {
  const pipeline = [
    ...(await adminUsersPipeline(params, now)),
    { $sort: adminUsersSort(params.sortField, params.sortOrder) },
    // Only the provider names, for the Signed up column's method; never the provider ids.
    { $project: { ...ADMIN_USER_PROJECTION, 'authProviders.strategy': 1 } },
  ];
  const [result] = await executeFacetCompatible(
    User,
    convertPipelineForDocumentDB(pipeline),
    {
      totalCount: [{ $count: 'count' }],
      paginatedResults: [{ $skip: (params.page - 1) * params.limit }, { $limit: params.limit }],
    },
    { maxTimeMS: LIST_MAX_TIME_MS }
  );
  const totalUsers: number = result.totalCount[0]?.count ?? 0;
  const rows: IUserObject[] = result.paginatedResults;
  await User.populate(rows, { path: 'organizationId' });

  const ids = rows.map(row => String(row._id));
  const [keyCounts, spend] = await Promise.all([
    ids.length > 0 ? liveApiKeyCounts(ids) : new Map<string, number>(),
    // Spend is a nice-to-have figure; a ledger failure must not take the list down with it.
    ids.length > 0
      ? spendLast30Days(ids, now).catch(error => {
          options.logError('Users list spend lookup failed', error);
          return null;
        })
      : new Map<string, number>(),
  ]);

  return {
    users: rows.map(row => {
      const id = String(row._id);
      // withSafeOrganization keeps its input's type, but it has replaced the populated org with the safe shape.
      const { authProviders, ...listed } = row as IUserObject & { authProviders?: { strategy?: string }[] };
      const user = withSafeOrganization(User.hydrate(listed).toJSON(), viewer) as unknown as AdminUserListItem;
      return {
        ...user,
        signupMethod: authProviders?.[0]?.strategy ?? 'email',
        apiKeyCount: keyCounts.get(id) ?? 0,
        spend30d: spend ? (spend.get(id) ?? 0) : null,
      };
    }),
    totalUsers,
    page: params.page,
    totalPages: Math.ceil(totalUsers / params.limit),
  };
}

/**
 * Hard ceiling on one CSV export; the response says when the filter matched more. Sized so the JSON
 * body (~260 bytes per row, ~430 worst case) stays under the 6 MB buffered Lambda response limit.
 */
export const USERS_EXPORT_MAX_ROWS = 15_000;
// ms. Reads more rows than a page, but must finish inside the 60 s server Lambda timeout.
const EXPORT_MAX_TIME_MS = 45_000;

export type AdminUsersExportRow = Pick<
  IUserObject,
  'name' | 'username' | 'email' | 'createdAt' | 'isAdmin' | 'isBanned'
> & {
  organizationName: string | null;
  loginCount: number;
  lastLoginAt: Date | null;
};

/** The CSV columns for every user the filter matches, newest first, up to USERS_EXPORT_MAX_ROWS. */
export async function exportAdminUsers(filter: AdminUsersFilter, now = new Date()) {
  const rows: (AdminUsersExportRow & { organizationId?: unknown })[] = await User.aggregate([
    ...(await adminUsersPipeline(filter, now)),
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: USERS_EXPORT_MAX_ROWS + 1 },
    {
      $project: {
        _id: 0,
        name: 1,
        username: 1,
        email: 1,
        createdAt: 1,
        isAdmin: 1,
        isBanned: 1,
        organizationId: 1,
        loginCount: { $size: { $ifNull: ['$loginRecords', []] } },
        lastLoginAt: { $max: '$loginRecords.loginTime' },
      },
    },
  ]).option({ maxTimeMS: EXPORT_MAX_TIME_MS, allowDiskUse: true });
  const organizationIds = [...new Set(rows.flatMap(row => (row.organizationId ? [String(row.organizationId)] : [])))];
  const organizations = await Organization.find({ _id: { $in: organizationIds } })
    .select('name')
    .lean();
  const names = new Map(organizations.map(organization => [String(organization._id), organization.name]));
  return {
    truncated: rows.length > USERS_EXPORT_MAX_ROWS,
    users: rows.slice(0, USERS_EXPORT_MAX_ROWS).map(({ organizationId, ...row }) => ({
      ...row,
      organizationName: organizationId ? (names.get(String(organizationId)) ?? null) : null,
      lastLoginAt: row.lastLoginAt ?? null,
    })),
  };
}

/** Email-domain groups for the filtered users, newest SIGNUP_SCAN_LIMIT accounts at most. */
export async function adminUsersDomainGroups(filter: AdminUsersFilter, now = new Date()) {
  const users = await User.aggregate([
    ...(await adminUsersPipeline(filter, now)),
    { $sort: { createdAt: -1, _id: -1 } },
    { $limit: SIGNUP_SCAN_LIMIT + 1 },
    { $project: { email: 1, createdAt: 1 } },
  ]).option({ maxTimeMS: LIST_MAX_TIME_MS });
  const { groups, keysTruncated } = await getDomainGroups(users.slice(0, SIGNUP_SCAN_LIMIT));
  return { groups, keysTruncated, groupsTruncated: users.length > SIGNUP_SCAN_LIMIT };
}

/** Header and built-in view counts. Each is one count over an indexed or bounded field. */
export async function adminUsersSummary(now = new Date()): Promise<AdminUsersSummary> {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [total, activeThisWeek, newThisWeek, highRisk, suspended] = await Promise.all([
    User.estimatedDocumentCount(),
    User.countDocuments({ lastActiveAt: { $gte: weekAgo } }).maxTimeMS(LIST_MAX_TIME_MS),
    User.countDocuments({ createdAt: { $gte: weekAgo } }).maxTimeMS(LIST_MAX_TIME_MS),
    User.countDocuments({ 'signupGrantAssessment.band': 'review' }).maxTimeMS(LIST_MAX_TIME_MS),
    User.countDocuments({ isBanned: true }).maxTimeMS(LIST_MAX_TIME_MS),
  ]);
  return { total, activeThisWeek, views: { newThisWeek, highRisk, suspended } };
}
