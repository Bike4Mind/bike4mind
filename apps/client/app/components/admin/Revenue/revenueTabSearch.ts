import {
  ADMIN_PAYMENTS_MAX_RANGE_DAYS,
  ADMIN_PAYMENTS_PAGE_SIZES,
  AdminPaymentsQuerySchema,
  PAYMENT_KINDS,
  PAYMENT_OWNER_TYPES,
  PAYMENT_STATUSES,
  daysBetween,
  defaultPaymentsRange,
  type AdminPaymentsFilter,
  type PaymentKind,
  type PaymentOwnerType,
  type PaymentStatus,
} from '@bike4mind/server-utils/app/utils/adminPayments';
import { oneOf, parsePage, toNumber } from '../adminSearchValues';

/**
 * The Revenue tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it. The payments search is left out on purpose: it
 * usually holds an email.
 */

export const ADMIN_REVENUE_TAB_SLUG = 'revenue';

export const REVENUE_VIEWS = ['subscriptions', 'payments'] as const;
export type RevenueView = (typeof REVENUE_VIEWS)[number];
export const DEFAULT_REVENUE_VIEW: RevenueView = 'subscriptions';

export const REVENUE_VIEW_PARAM = 'revenueView';

/** Payments filter -> URL param. Amounts are major units as typed; dates are UTC days. */
export const PAYMENTS_SEARCH_PARAMS = {
  from: 'payFrom',
  to: 'payTo',
  kind: 'payKind',
  status: 'payStatus',
  ownerType: 'payOwner',
  currency: 'payCurrency',
  minAmount: 'payMin',
  maxAmount: 'payMax',
  page: 'payPage',
  limit: 'payLimit',
} as const;

export const REVENUE_TAB_PARAMS = [REVENUE_VIEW_PARAM, ...Object.values(PAYMENTS_SEARCH_PARAMS)] as const;

export type RevenueSearch = {
  revenueView?: RevenueView;
  payFrom?: string;
  payTo?: string;
  payKind?: PaymentKind;
  payStatus?: PaymentStatus;
  payOwner?: PaymentOwnerType;
  payCurrency?: string;
  payMin?: number;
  payMax?: number;
  payPage?: number;
  payLimit?: number;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The API's upper bound on an amount, in major units of a 2-decimal currency. */
const MAX_MAJOR_AMOUNT = 100_000_000;

export const parseIsoDay = (value: unknown): string | undefined =>
  typeof value === 'string' && ISO_DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ? value
    : undefined;

const parseCurrency = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  return /^[a-z]{3}$/.test(code) ? code : undefined;
};

export const parseMajorAmount = (value: unknown): number | undefined => {
  const amount = toNumber(value);
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_MAJOR_AMOUNT ? amount : undefined;
};

const parsePaymentsPage = (value: unknown): number | undefined => {
  const page = parsePage(value);
  if (page === undefined) return undefined;
  return AdminPaymentsQuerySchema.safeParse({ page }).success ? page : undefined;
};

const parsePaymentsLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return (ADMIN_PAYMENTS_PAGE_SIZES as readonly number[]).includes(limit) ? limit : undefined;
};

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const REVENUE_SEARCH_PARSERS: { readonly [K in keyof RevenueSearch]-?: (value: unknown) => RevenueSearch[K] } = {
  revenueView: oneOf(REVENUE_VIEWS),
  payFrom: parseIsoDay,
  payTo: parseIsoDay,
  payKind: oneOf(PAYMENT_KINDS),
  payStatus: oneOf(PAYMENT_STATUSES),
  payOwner: oneOf(PAYMENT_OWNER_TYPES),
  payCurrency: parseCurrency,
  payMin: parseMajorAmount,
  payMax: parseMajorAmount,
  payPage: parsePaymentsPage,
  payLimit: parsePaymentsLimit,
};

export const revenueViewFromSearch = (search: Record<string, unknown>): RevenueView =>
  REVENUE_SEARCH_PARSERS.revenueView(search[REVENUE_VIEW_PARAM]) ?? DEFAULT_REVENUE_VIEW;

/** The Payments filters as the page holds them: amounts in major units, as typed. */
export type PaymentsParams = {
  from: string;
  to: string;
  kind?: PaymentKind;
  status?: PaymentStatus;
  ownerType?: PaymentOwnerType;
  currency?: string;
  minAmount?: number;
  maxAmount?: number;
  page: number;
  limit: number;
};

export const DEFAULT_PAYMENTS_PAGE_SIZE = 25;

/** The filters a URL describes; a missing range falls back to the last 30 UTC days ending `now`. */
export function paymentsParamsFromSearch(search: Record<string, unknown>, now: Date): PaymentsParams {
  const parsers = REVENUE_SEARCH_PARSERS;
  const fallback = defaultPaymentsRange(now);
  return {
    from: parsers.payFrom(search.payFrom) ?? fallback.from,
    to: parsers.payTo(search.payTo) ?? fallback.to,
    kind: parsers.payKind(search.payKind),
    status: parsers.payStatus(search.payStatus),
    ownerType: parsers.payOwner(search.payOwner),
    currency: parsers.payCurrency(search.payCurrency),
    minAmount: parsers.payMin(search.payMin),
    maxAmount: parsers.payMax(search.payMax),
    page: parsers.payPage(search.payPage) ?? 1,
    limit: parsers.payLimit(search.payLimit) ?? DEFAULT_PAYMENTS_PAGE_SIZE,
  };
}

/** The URL patch for a change to the Payments filters; the default page and page size are left out. */
export function paymentsParamsToSearch(params: Partial<PaymentsParams>): RevenueSearch {
  // A key present with `undefined` clears that param, so only the keys in the patch are written.
  const patch: RevenueSearch = {};
  if ('from' in params) patch.payFrom = params.from;
  if ('to' in params) patch.payTo = params.to;
  if ('kind' in params) patch.payKind = params.kind;
  if ('status' in params) patch.payStatus = params.status;
  if ('ownerType' in params) patch.payOwner = params.ownerType;
  if ('currency' in params) patch.payCurrency = params.currency;
  if ('minAmount' in params) patch.payMin = params.minAmount;
  if ('maxAmount' in params) patch.payMax = params.maxAmount;
  if ('page' in params) patch.payPage = params.page === 1 ? undefined : params.page;
  if ('limit' in params) patch.payLimit = params.limit === DEFAULT_PAYMENTS_PAGE_SIZE ? undefined : params.limit;
  return patch;
}

/** Major units as typed to the API's minor units (2-decimal currencies). */
export const toMinorAmount = (major: number | undefined): number | undefined =>
  major === undefined ? undefined : Math.round(major * 100);

/** Why the filters cannot be sent, in words for the admin; null when they can. */
export function paymentsParamsError(params: PaymentsParams): string | null {
  if (params.from > params.to) return 'The From date must be on or before the To date.';
  if (daysBetween(params.from, params.to) > ADMIN_PAYMENTS_MAX_RANGE_DAYS)
    return `Pick a range of at most ${ADMIN_PAYMENTS_MAX_RANGE_DAYS} days.`;
  if (params.minAmount !== undefined && params.maxAmount !== undefined && params.minAmount > params.maxAmount)
    return 'The minimum amount must not exceed the maximum.';
  return null;
}

/** The API filter (no page or limit) for the summary and the export. */
export function paymentsApiFilter(params: PaymentsParams, search: string): AdminPaymentsFilter {
  const trimmed = search.trim();
  return {
    from: params.from,
    to: params.to,
    kind: params.kind,
    status: params.status,
    ownerType: params.ownerType,
    currency: params.currency,
    minAmount: toMinorAmount(params.minAmount),
    maxAmount: toMinorAmount(params.maxAmount),
    search: trimmed || undefined,
  };
}

/** Filters beyond the default range: what "Clear filters" resets. */
export const PAYMENTS_FILTER_KEYS = ['kind', 'status', 'ownerType', 'currency', 'minAmount', 'maxAmount'] as const;

export const CLEARED_PAYMENTS_FILTERS: Pick<PaymentsParams, (typeof PAYMENTS_FILTER_KEYS)[number]> = {
  kind: undefined,
  status: undefined,
  ownerType: undefined,
  currency: undefined,
  minAmount: undefined,
  maxAmount: undefined,
};

export const hasPaymentsFilters = (params: PaymentsParams, search: string): boolean =>
  search.trim() !== '' || PAYMENTS_FILTER_KEYS.some(key => params[key] !== undefined);
