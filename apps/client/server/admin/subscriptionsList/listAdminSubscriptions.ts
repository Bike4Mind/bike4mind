import {
  Organization,
  User,
  convertPipelineForDocumentDB,
  executeFacetCompatible,
  mongoose,
} from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import type {
  AdminSubscriptionOwner,
  AdminSubscriptionRow,
  AdminSubscriptionsFilter,
  AdminSubscriptionsListParams,
  AdminSubscriptionsListResponse,
  AdminSubscriptionsSummary,
} from '@client/app/utils/adminSubscriptionsFilter';
import { Subscription } from '@bike4mind/server-utils/models/Subscription';
import {
  adminSubscriptionsSort,
  buildAdminSubscriptionsMatch,
  classifySearch,
  ownersCondition,
  planOf,
  subscriptionPlanCatalog,
  viewConditions,
  type PlanCatalog,
} from './adminSubscriptionsQuery';
import { billedIntervalOf, mrrGroupStages, mrrTotal, subscriptionMrr, type MrrGroup } from './subscriptionMrr';

// ms. A list read that runs past this is a filter the indexes cannot serve; fail it rather than queue.
const LIST_MAX_TIME_MS = 10_000;
/** Owners one text search may resolve to. Past this the search is reported as truncated. */
export const OWNER_SEARCH_LIMIT = 500;

type Condition = Record<string, unknown>;

export type SubscriptionDoc = {
  _id: mongoose.Types.ObjectId;
  subscriptionId: string;
  ownerType: AdminSubscriptionRow['ownerType'];
  ownerId: string;
  priceId?: string | null;
  status: string;
  source?: AdminSubscriptionRow['source'];
  quantity: number;
  customCreditsPerCycle?: number | null;
  // Rows copied in by the UserSubscription migration were raw inserts that skipped schema validation, so
  // these required-in-schema dates can be missing on legacy documents.
  periodStartsAt?: Date | null;
  periodEndsAt?: Date | null;
  canceledAt?: Date | null;
  createdAt?: Date | null;
  unitAmount?: number | null;
  currency?: string | null;
  interval?: string | null;
  intervalCount?: number | null;
};

type ResolvedSearch = { condition?: Condition; truncated: boolean };

const idStrings = (docs: { _id: unknown }[]) => docs.map(doc => String(doc._id));

// One past the limit, so a truncated search is detectable.
const userIdsMatching = async (query: Condition) =>
  idStrings(
    await User.find(query)
      .select('_id')
      .limit(OWNER_SEARCH_LIMIT + 1)
      .maxTimeMS(LIST_MAX_TIME_MS)
      .lean()
  );

const organizationIdsMatching = async (query: Condition) =>
  idStrings(
    await Organization.find(query)
      .select('_id')
      .limit(OWNER_SEARCH_LIMIT + 1)
      .maxTimeMS(LIST_MAX_TIME_MS)
      .lean()
  );

/**
 * Resolves the free-text search to owner ids first, so the subscription read stays on its
 * `{ownerType, ownerId}` index. An org also matches through its billing owner, since a team-plan
 * customer usually writes in from their own address.
 */
export async function resolveSearch(search: string | undefined): Promise<ResolvedSearch> {
  if (!search) return { truncated: false };
  const kind = classifySearch(search);
  if (kind === 'subscriptionId') return { condition: { subscriptionId: search }, truncated: false };
  if (kind === 'objectId') {
    // ownerId is a stored string, so it only matches the canonical lowercase hex.
    const id = search.toLowerCase();
    const billedOrganizationIds = await organizationIdsMatching({ userId: id });
    return {
      condition: {
        $or: [
          { _id: new mongoose.Types.ObjectId(id) },
          { ownerType: { $in: ['User', 'Organization'] }, ownerId: id },
          { ownerType: 'Organization', ownerId: { $in: billedOrganizationIds.slice(0, OWNER_SEARCH_LIMIT) } },
        ],
      },
      truncated: billedOrganizationIds.length > OWNER_SEARCH_LIMIT,
    };
  }

  const userQuery =
    kind === 'customerId'
      ? { stripeCustomerId: search }
      : {
          $or: ['name', 'username', 'email'].map(field => ({
            [field]: { $regex: escapeRegex(search), $options: 'i' },
          })),
        };
  const userIds = await userIdsMatching(userQuery);
  const orgQuery =
    kind === 'customerId'
      ? { stripeCustomerId: search }
      : { $or: [{ name: { $regex: escapeRegex(search), $options: 'i' } }, { userId: { $in: userIds } }] };
  const organizationIds = await organizationIdsMatching(orgQuery);
  const truncated = userIds.length > OWNER_SEARCH_LIMIT || organizationIds.length > OWNER_SEARCH_LIMIT;
  return {
    condition: ownersCondition({
      userIds: userIds.slice(0, OWNER_SEARCH_LIMIT),
      organizationIds: organizationIds.slice(0, OWNER_SEARCH_LIMIT),
    }),
    truncated,
  };
}

export async function adminSubscriptionsMatch(
  filter: AdminSubscriptionsFilter,
  now: Date,
  catalog: PlanCatalog
): Promise<{ match: Condition; searchTruncated: boolean }> {
  const search = await resolveSearch(filter.search);
  return {
    match: buildAdminSubscriptionsMatch(filter, { now, catalog, searchCondition: search.condition }),
    searchTruncated: search.truncated,
  };
}

const toObjectIds = (ids: string[]) =>
  ids.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));

async function ownersOf(docs: SubscriptionDoc[]): Promise<Map<string, AdminSubscriptionOwner>> {
  const userIds = docs.filter(doc => doc.ownerType === 'User').map(doc => doc.ownerId);
  const organizationIds = docs.filter(doc => doc.ownerType === 'Organization').map(doc => doc.ownerId);
  const [users, organizations] = await Promise.all([
    userIds.length > 0
      ? User.find({ _id: { $in: toObjectIds(userIds) } })
          .select('name username email stripeCustomerId')
          .lean()
      : [],
    organizationIds.length > 0
      ? Organization.find({ _id: { $in: toObjectIds(organizationIds) } })
          .select('name stripeCustomerId seats userId users.userId')
          .lean()
      : [],
  ]);

  const owners = new Map<string, AdminSubscriptionOwner>();
  for (const user of users) {
    owners.set(`User:${String(user._id)}`, {
      kind: 'User',
      id: String(user._id),
      name: user.name ?? null,
      username: user.username ?? null,
      email: user.email ?? null,
      stripeCustomerId: user.stripeCustomerId ?? null,
    });
  }
  for (const organization of organizations) {
    owners.set(`Organization:${String(organization._id)}`, {
      kind: 'Organization',
      id: String(organization._id),
      name: organization.name ?? null,
      stripeCustomerId: organization.stripeCustomerId ?? null,
      seats: organization.seats ?? null,
      memberCount: (organization.users?.length ?? 0) + 1,
      billingOwnerId: organization.userId ?? null,
    });
  }
  return owners;
}

const isoOrNull = (date: Date | null | undefined) => (date ? date.toISOString() : null);

export async function toAdminSubscriptionRows(
  docs: SubscriptionDoc[],
  catalog: PlanCatalog
): Promise<AdminSubscriptionRow[]> {
  const owners = await ownersOf(docs);
  return docs.map(doc => ({
    id: String(doc._id),
    subscriptionId: doc.subscriptionId,
    ownerType: doc.ownerType,
    ownerId: doc.ownerId,
    owner: owners.get(`${doc.ownerType}:${doc.ownerId}`) ?? null,
    plan: planOf(doc.priceId, catalog),
    billedInterval: doc.source === 'admin_grant' ? null : billedIntervalOf(doc.interval, doc.intervalCount),
    status: doc.status,
    source: doc.source ?? 'stripe',
    quantity: doc.quantity,
    customCreditsPerCycle: doc.customCreditsPerCycle ?? null,
    mrr: subscriptionMrr(doc),
    periodStartsAt: isoOrNull(doc.periodStartsAt),
    periodEndsAt: isoOrNull(doc.periodEndsAt),
    canceledAt: isoOrNull(doc.canceledAt),
    createdAt: isoOrNull(doc.createdAt),
  }));
}

const asStages = (stages: Condition[]) => stages as unknown as mongoose.PipelineStage[];

export async function listAdminSubscriptions(
  params: AdminSubscriptionsListParams,
  now = new Date()
): Promise<AdminSubscriptionsListResponse> {
  const catalog = subscriptionPlanCatalog();
  const { match, searchTruncated } = await adminSubscriptionsMatch(params, now, catalog);
  const pipeline = asStages([{ $match: match }, { $sort: adminSubscriptionsSort(params.sortField, params.sortOrder) }]);
  const [result] = await executeFacetCompatible(
    Subscription,
    convertPipelineForDocumentDB(pipeline),
    {
      totalCount: [{ $count: 'count' }],
      paginatedResults: [{ $skip: (params.page - 1) * params.limit }, { $limit: params.limit }],
    },
    { maxTimeMS: LIST_MAX_TIME_MS }
  );
  const total: number = result.totalCount[0]?.count ?? 0;
  return {
    subscriptions: await toAdminSubscriptionRows(result.paginatedResults as SubscriptionDoc[], catalog),
    total,
    page: params.page,
    totalPages: Math.ceil(total / params.limit),
    searchTruncated,
  };
}

const countOf = (facet: { count: number }[]) => facet[0]?.count ?? 0;

export async function adminSubscriptionsSummary(
  filter: AdminSubscriptionsFilter,
  now = new Date()
): Promise<AdminSubscriptionsSummary> {
  const { match, searchTruncated } = await adminSubscriptionsMatch(filter, now, subscriptionPlanCatalog());
  const views = viewConditions(now);
  const [result] = await executeFacetCompatible(
    Subscription,
    convertPipelineForDocumentDB(asStages([{ $match: match }])),
    {
      total: [{ $count: 'count' }],
      paying: [{ $match: views.paying }, { $count: 'count' }],
      pastDue: [{ $match: views.pastDue }, { $count: 'count' }],
      comped: [{ $match: views.comped }, { $count: 'count' }],
      churned: [{ $match: views.churned }, { $count: 'count' }],
      mrr: mrrGroupStages(),
      pastDueMrr: mrrGroupStages(views.pastDue),
    },
    { maxTimeMS: LIST_MAX_TIME_MS }
  );
  return {
    total: countOf(result.total),
    views: {
      paying: countOf(result.paying),
      pastDue: countOf(result.pastDue),
      comped: countOf(result.comped),
      churned: countOf(result.churned),
    },
    mrr: mrrTotal(result.mrr as MrrGroup[]),
    pastDueMrr: mrrTotal(result.pastDueMrr as MrrGroup[]),
    searchTruncated,
  };
}

/** `createdAt` is null past the rows that lack one: `{ createdAt: null }` matches a missing field and those sort last. */
export type ExportCursor = { createdAt: Date | null; id: string };

/** One keyset page of the export, newest first. Reads `limit` rows; the caller asks for one extra to probe for more. */
export async function adminSubscriptionsExportPage(
  match: Condition,
  after: ExportCursor | null,
  limit: number,
  catalog: PlanCatalog
): Promise<AdminSubscriptionRow[]> {
  const keyset: Condition | null = after
    ? {
        $or: [
          { createdAt: { $lt: after.createdAt } },
          { createdAt: after.createdAt, _id: { $lt: new mongoose.Types.ObjectId(after.id) } },
          // $lt on a Date never matches a missing createdAt, so a dated cursor must reach the undated tail
          // explicitly. A null cursor is already inside that tail and must not restart it.
          ...(after.createdAt ? [{ createdAt: null }] : []),
        ],
      }
    : null;
  const query = keyset ? { $and: [match, keyset] } : match;
  const docs = await Subscription.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .maxTimeMS(LIST_MAX_TIME_MS)
    .lean<SubscriptionDoc[]>();
  return toAdminSubscriptionRows(docs, catalog);
}
