import { ADMIN_TAB_PARAM } from '@bike4mind/common';
import {
  ADMIN_SUBSCRIPTIONS_LIST_MAX,
  ADMIN_SUBSCRIPTIONS_PAGE_SIZES,
  ADMIN_SUBSCRIPTIONS_SORT_FIELDS,
  AdminSubscriptionsQuerySchema,
  SUBSCRIPTION_CANCEL_FILTERS,
  SUBSCRIPTION_INTERVAL_FILTERS,
  SUBSCRIPTION_OWNER_TYPE_FILTERS,
  SUBSCRIPTION_RENEWS_FILTERS,
  SUBSCRIPTION_SOURCE_FILTERS,
  SUBSCRIPTION_STATUS_FILTERS,
  type AdminSubscriptionsFilter,
  type AdminSubscriptionsSortField,
  type SubscriptionStatusFilter,
} from '@client/app/utils/adminSubscriptionsFilter';
import { oneOf, parsePage, parseStringList, toNumber } from '../adminSearchValues';

/**
 * The Subscriptions tab's `/admin` search params and their coercion. Pure and React-free:
 * adminTabParams.ts (and through it router.tsx's eager import) reads it. The free-text search is left
 * out because it usually holds an email; the `subs` prefix is because Users owns the bare names.
 */

// Re-exported by adminTabParams.ts, which imports this file.
export const ADMIN_SUBSCRIPTIONS_TAB_SLUG = 'subscriptions';

const SORT_ORDERS = ['asc', 'desc'] as const;

export type SubscriptionsListView = Omit<AdminSubscriptionsFilter, 'search'> & {
  page: number;
  limit: number;
  sortField: AdminSubscriptionsSortField;
  sortOrder: (typeof SORT_ORDERS)[number];
};
export type SubscriptionsListParams = SubscriptionsListView & { search: string };

export type SubscriptionsFilterKey = Exclude<keyof AdminSubscriptionsFilter, 'search'>;

/** The Paying view (subscriptionsListViews.ts), which is also what a first visit opens on. */
export const PAYING_FILTERS: Pick<SubscriptionsListView, 'status' | 'source'> = {
  status: ['active', 'past_due'],
  source: 'stripe',
};

export const DEFAULT_SUBSCRIPTIONS_PARAMS: SubscriptionsListParams = {
  page: 1,
  limit: 25,
  search: '',
  sortField: 'createdAt',
  sortOrder: 'desc',
  ...PAYING_FILTERS,
};

/** List filter -> URL param. */
export const SUBSCRIPTIONS_FILTER_PARAMS = {
  status: 'subsStatus',
  plan: 'subsPlan',
  ownerType: 'subsOwner',
  source: 'subsSource',
  interval: 'subsInterval',
  renews: 'subsRenews',
  cancel: 'subsCancel',
} as const satisfies Record<SubscriptionsFilterKey, string>;
export const SUBSCRIPTIONS_FILTER_KEYS = Object.keys(SUBSCRIPTIONS_FILTER_PARAMS) as SubscriptionsFilterKey[];

export const SUBSCRIPTIONS_PAGE_PARAM = 'subsPage';
export const SUBSCRIPTIONS_LIMIT_PARAM = 'subsLimit';
export const SUBSCRIPTIONS_SORT_PARAM = 'subsSort';
export const SUBSCRIPTIONS_ORDER_PARAM = 'subsOrder';

export const SUBSCRIPTIONS_TAB_PARAMS = [
  SUBSCRIPTIONS_PAGE_PARAM,
  SUBSCRIPTIONS_LIMIT_PARAM,
  SUBSCRIPTIONS_SORT_PARAM,
  SUBSCRIPTIONS_ORDER_PARAM,
  ...Object.values(SUBSCRIPTIONS_FILTER_PARAMS),
] as const;

export type SubscriptionsSearch = {
  subsPage?: number;
  subsLimit?: number;
  subsSort?: AdminSubscriptionsSortField;
  subsOrder?: (typeof SORT_ORDERS)[number];
  subsStatus?: SubscriptionStatusFilter[];
  subsPlan?: string[];
  subsOwner?: SubscriptionsListView['ownerType'];
  subsSource?: SubscriptionsListView['source'];
  subsInterval?: SubscriptionsListView['interval'];
  subsRenews?: SubscriptionsListView['renews'];
  subsCancel?: SubscriptionsListView['cancel'];
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return (ADMIN_SUBSCRIPTIONS_PAGE_SIZES as readonly number[]).includes(limit) ? limit : undefined;
};

/** Known statuses only, de-duplicated and in SUBSCRIPTION_STATUS_FILTERS order, so equal sets compare equal. */
export const parseStatusList = (value: unknown): SubscriptionStatusFilter[] | undefined => {
  const picked = new Set(parseStringList(value) ?? []);
  const statuses = SUBSCRIPTION_STATUS_FILTERS.filter(status => picked.has(status));
  return statuses.length > 0 ? statuses : undefined;
};

// Price ids, or `unknown`: the same bound as AdminSubscriptionsFilterSchema.plan, so a link never
// carries a plan list the API rejects.
const parsePlanList = (value: unknown): string[] | undefined => {
  const plans = [...new Set(parseStringList(value) ?? [])]
    .filter(plan => /^[\w-]{1,200}$/.test(plan))
    .slice(0, ADMIN_SUBSCRIPTIONS_LIST_MAX);
  return plans.length > 0 ? plans : undefined;
};

const VIEW_PARAMS: readonly string[] = SUBSCRIPTIONS_TAB_PARAMS;

// A view param that fails to parse still asked for a view. Keeping the default page stops
// `validateSearch` from reducing `?subsSort=bogus` to a bare visit that restores the saved view.
const parseBoundedPage = (value: unknown): number | undefined => {
  const page = parsePage(value);
  if (page === undefined) return undefined;
  const parsed = AdminSubscriptionsQuerySchema.shape.page.safeParse(page);
  return parsed.success ? parsed.data : undefined;
};

const parseSubscriptionsPage = (value: unknown, search: Record<string, unknown> = {}): number | undefined =>
  parseBoundedPage(value) ??
  (search[ADMIN_TAB_PARAM] === ADMIN_SUBSCRIPTIONS_TAB_SLUG && VIEW_PARAMS.some(key => search[key] !== undefined)
    ? DEFAULT_SUBSCRIPTIONS_PARAMS.page
    : undefined);

/**
 * Per-key coercion for the route's `validateSearch`, given the whole raw search as well; anything
 * invalid becomes undefined.
 */
export const SUBSCRIPTIONS_SEARCH_PARSERS: {
  readonly [K in keyof SubscriptionsSearch]-?: (
    value: unknown,
    search?: Record<string, unknown>
  ) => SubscriptionsSearch[K];
} = {
  subsPage: parseSubscriptionsPage,
  subsLimit: parseLimit,
  subsSort: oneOf(ADMIN_SUBSCRIPTIONS_SORT_FIELDS),
  subsOrder: oneOf(SORT_ORDERS),
  subsStatus: parseStatusList,
  subsPlan: parsePlanList,
  subsOwner: oneOf(SUBSCRIPTION_OWNER_TYPE_FILTERS),
  subsSource: oneOf(SUBSCRIPTION_SOURCE_FILTERS),
  subsInterval: oneOf(SUBSCRIPTION_INTERVAL_FILTERS),
  subsRenews: oneOf(SUBSCRIPTION_RENEWS_FILTERS),
  subsCancel: oneOf(SUBSCRIPTION_CANCEL_FILTERS),
};

function filtersFromSearch(search: Record<string, unknown>): Pick<SubscriptionsListView, SubscriptionsFilterKey> {
  const parsers = SUBSCRIPTIONS_SEARCH_PARSERS;
  return {
    status: parsers.subsStatus(search.subsStatus),
    plan: parsers.subsPlan(search.subsPlan),
    ownerType: parsers.subsOwner(search.subsOwner),
    source: parsers.subsSource(search.subsSource),
    interval: parsers.subsInterval(search.subsInterval),
    renews: parsers.subsRenews(search.subsRenews),
    cancel: parsers.subsCancel(search.subsCancel),
  };
}

/**
 * The list view a URL describes, or undefined when it carries none of the view params (a bare
 * `?tab=subscriptions`, which restores the last view). With any view param present the URL is the
 * whole view: a missing filter is unset, so a shared link never picks up the recipient's filters.
 */
export function subscriptionsViewFromSearch(search: Record<string, unknown>): SubscriptionsListView | undefined {
  const parsed = {
    page: parseBoundedPage(search[SUBSCRIPTIONS_PAGE_PARAM]),
    limit: parseLimit(search[SUBSCRIPTIONS_LIMIT_PARAM]),
    sortField: SUBSCRIPTIONS_SEARCH_PARSERS.subsSort(search[SUBSCRIPTIONS_SORT_PARAM]),
    sortOrder: SUBSCRIPTIONS_SEARCH_PARSERS.subsOrder(search[SUBSCRIPTIONS_ORDER_PARAM]),
    ...filtersFromSearch(search),
  };
  if (Object.values(parsed).every(value => value === undefined)) return undefined;
  // Unset filters stay as explicit undefined keys, so spreading a view over stored params clears them.
  return {
    ...parsed,
    page: parsed.page ?? DEFAULT_SUBSCRIPTIONS_PARAMS.page,
    limit: parsed.limit ?? DEFAULT_SUBSCRIPTIONS_PARAMS.limit,
    sortField: parsed.sortField ?? DEFAULT_SUBSCRIPTIONS_PARAMS.sortField,
    sortOrder: parsed.sortOrder ?? DEFAULT_SUBSCRIPTIONS_PARAMS.sortOrder,
  };
}

/**
 * The view params to write. Default page size and sort are left out to keep links short; `page` is
 * always written so every Subscriptions URL reads back as a whole view, including the unfiltered one.
 */
export function subscriptionsViewToSearch(view: SubscriptionsListView): SubscriptionsSearch {
  const unlessDefault = <T>(value: T, isDefault: boolean): T | undefined => (isDefault ? undefined : value);
  return {
    subsPage: parseBoundedPage(view.page) ?? DEFAULT_SUBSCRIPTIONS_PARAMS.page,
    subsLimit: unlessDefault(parseLimit(view.limit), view.limit === DEFAULT_SUBSCRIPTIONS_PARAMS.limit),
    subsSort: unlessDefault(view.sortField, view.sortField === DEFAULT_SUBSCRIPTIONS_PARAMS.sortField),
    subsOrder: unlessDefault(view.sortOrder, view.sortOrder === DEFAULT_SUBSCRIPTIONS_PARAMS.sortOrder),
    subsStatus: parseStatusList(view.status),
    subsPlan: parsePlanList(view.plan),
    subsOwner: view.ownerType,
    subsSource: view.source,
    subsInterval: view.interval,
    subsRenews: view.renews,
    subsCancel: view.cancel,
  };
}

const sameList = (a: readonly string[] = [], b: readonly string[] = []) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/** Whether two param sets describe the same list view (the free-text search is not compared). */
export function isSameSubscriptionsView(a: SubscriptionsListView, b: SubscriptionsListView): boolean {
  return (
    a.page === b.page &&
    a.limit === b.limit &&
    a.sortField === b.sortField &&
    a.sortOrder === b.sortOrder &&
    sameList(a.status, b.status) &&
    sameList(a.plan, b.plan) &&
    a.ownerType === b.ownerType &&
    a.source === b.source &&
    a.interval === b.interval &&
    a.renews === b.renews &&
    a.cancel === b.cancel
  );
}

/** Every filter cleared: what "Clear filters" and the All view apply. Keeps sort and page size. */
export const CLEARED_FILTER_PARAMS: Partial<SubscriptionsListParams> = {
  page: 1,
  ...Object.fromEntries(SUBSCRIPTIONS_FILTER_KEYS.map(key => [key, undefined])),
};

export const countActiveFilters = (view: SubscriptionsListView): number =>
  SUBSCRIPTIONS_FILTER_KEYS.filter(key => {
    const value = view[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  }).length;
