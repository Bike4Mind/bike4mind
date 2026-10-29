import {
  DELINQUENT_SUBSCRIPTION_STATUSES,
  SubscriptionSource,
  TERMINAL_SUBSCRIPTION_STATUSES,
} from '@bike4mind/server-utils/lib/subscriptions/types';
import {
  CHURNED_WINDOW_MS,
  RENEWS_WINDOW_MS,
  UNKNOWN_PLAN_FILTER,
  type AdminSubscriptionPlan,
  type AdminSubscriptionsFilter,
  type AdminSubscriptionsSortField,
  type AdminSubscriptionsSummary,
} from '@client/app/utils/adminSubscriptionsFilter';
import { SUBSCRIPTION_PLANS, TEAM_PLAN } from '@client/lib/userSubscriptions/constants';

/**
 * Pure filter, view and sort builders for the admin subscriptions list. Plain objects only, so they
 * stay mongoose-free and unit-testable; listAdminSubscriptions.ts runs them.
 */

type Condition = Record<string, unknown>;

export type PlanCatalog = ReadonlyMap<string, Pick<AdminSubscriptionPlan, 'name' | 'interval'>>;

const TERMINAL = [...TERMINAL_SUBSCRIPTION_STATUSES];
const DELINQUENT = [...DELINQUENT_SUBSCRIPTION_STATUSES];

/**
 * Every price checkout sells, individual and Team. Price ids come from env per stage and are empty
 * when unset, so empty ids are skipped rather than matching rows with no price.
 */
export function subscriptionPlanCatalog(): PlanCatalog {
  const plans = [...SUBSCRIPTION_PLANS, TEAM_PLAN];
  return new Map(
    plans.filter(plan => plan.priceId).map(plan => [plan.priceId, { name: plan.name, interval: plan.interval }])
  );
}

export function planOf(priceId: string | null | undefined, catalog: PlanCatalog): AdminSubscriptionPlan {
  const known = priceId ? catalog.get(priceId) : undefined;
  return { priceId: priceId || null, name: known?.name ?? null, interval: known?.interval ?? null };
}

function planCondition(plans: string[], catalog: PlanCatalog): Condition {
  const priceIds = plans.filter(plan => plan !== UNKNOWN_PLAN_FILTER);
  const branches: Condition[] = [];
  if (priceIds.length > 0) branches.push({ priceId: { $in: priceIds } });
  if (plans.includes(UNKNOWN_PLAN_FILTER)) branches.push({ priceId: { $nin: [...catalog.keys()] } });
  return branches.length === 1 ? branches[0] : { $or: branches };
}

function renewsCondition(renews: NonNullable<AdminSubscriptionsFilter['renews']>, now: Date): Condition {
  const live = { status: { $nin: TERMINAL } };
  if (renews === 'overdue') return { ...live, periodEndsAt: { $lt: now } };
  return { ...live, periodEndsAt: { $gte: now, $lt: new Date(now.getTime() + RENEWS_WINDOW_MS[renews]) } };
}

export type SearchKind = 'subscriptionId' | 'customerId' | 'objectId' | 'text';

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Ids a support ticket arrives with match exactly; anything else is an owner name, email or org name. */
export function classifySearch(search: string): SearchKind {
  if (/^(sub_|admin_grant_)/.test(search)) return 'subscriptionId';
  if (search.startsWith('cus_')) return 'customerId';
  if (OBJECT_ID.test(search)) return 'objectId';
  return 'text';
}

export type ResolvedOwners = { userIds: string[]; organizationIds: string[] };

export function ownersCondition({ userIds, organizationIds }: ResolvedOwners): Condition {
  return {
    $or: [
      { ownerType: 'User', ownerId: { $in: userIds } },
      { ownerType: 'Organization', ownerId: { $in: organizationIds } },
    ],
  };
}

export type MatchContext = {
  now: Date;
  catalog: PlanCatalog;
  /** The search, already resolved to a condition on subscription fields. */
  searchCondition?: Condition;
};

export function buildAdminSubscriptionsMatch(filter: AdminSubscriptionsFilter, context: MatchContext): Condition {
  const conditions: Condition[] = [];
  if (context.searchCondition) conditions.push(context.searchCondition);
  if (filter.status?.length) conditions.push({ status: { $in: filter.status } });
  if (filter.plan?.length) conditions.push(planCondition(filter.plan, context.catalog));
  if (filter.interval) {
    const priceIds = [...context.catalog].filter(([, plan]) => plan.interval === filter.interval).map(([id]) => id);
    conditions.push({ priceId: { $in: priceIds } });
  }
  if (filter.ownerType) conditions.push({ ownerType: filter.ownerType });
  if (filter.source) conditions.push({ source: filter.source });
  if (filter.renews) conditions.push(renewsCondition(filter.renews, context.now));
  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0] : { $and: conditions };
}

/**
 * The built-in views' conditions. Must stay in sync with the views table in
 * docs/admin-subscriptions-spec.md section 5.1 and the list page's view definitions.
 */
export function viewConditions(now: Date): Record<keyof AdminSubscriptionsSummary['views'], Condition> {
  return {
    paying: { source: SubscriptionSource.Stripe, status: { $in: ['active', 'past_due'] } },
    pastDue: { status: { $in: DELINQUENT } },
    comped: { source: SubscriptionSource.AdminGrant, status: { $nin: TERMINAL } },
    churned: { status: 'canceled', canceledAt: { $gte: new Date(now.getTime() - CHURNED_WINDOW_MS) } },
  };
}

/** Always tie-broken on `_id`, so a page boundary never repeats or skips a row. */
export function adminSubscriptionsSort(
  field: AdminSubscriptionsSortField,
  order: 'asc' | 'desc'
): Record<string, 1 | -1> {
  const direction = order === 'asc' ? 1 : -1;
  return { [field]: direction, _id: direction };
}
