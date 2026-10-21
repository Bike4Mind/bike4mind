import {
  FEEDBACK_ID_PARAM,
  FEEDBACK_LIST_DEFAULT_LIMIT,
  FEEDBACK_SUBJECTS,
  FeedbackStatus,
  type FeedbackSubject,
} from '@bike4mind/common';
import { oneOf, parsePage, parseStringList, toNumber } from '../adminSearchValues';
import { FEEDBACK_PAGE_SIZE_OPTIONS } from './constants';

/**
 * The Feedback tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it. The free-text search box is deliberately
 * absent - it often holds a username or an email, and these URLs get shared and copied into login
 * redirects. Page, limit and org carry a `feedback` prefix because the Users tab already owns the
 * bare names, and the registry gives every param exactly one owner.
 */

export const FEEDBACK_STATUS_PARAM = 'status';
export const FEEDBACK_SUBJECT_PARAM = 'subject';
export const FEEDBACK_ORG_PARAM = 'feedbackOrg';
export const FEEDBACK_ASC_PARAM = 'asc';
export const FEEDBACK_PAGE_PARAM = 'feedbackPage';
export const FEEDBACK_LIMIT_PARAM = 'feedbackLimit';

/** The params that describe the list view; `feedbackId` (the pinned report) is separate. */
const FEEDBACK_VIEW_PARAMS = [
  FEEDBACK_STATUS_PARAM,
  FEEDBACK_SUBJECT_PARAM,
  FEEDBACK_ORG_PARAM,
  FEEDBACK_ASC_PARAM,
  FEEDBACK_PAGE_PARAM,
  FEEDBACK_LIMIT_PARAM,
] as const;

export const FEEDBACK_TAB_PARAMS = [...FEEDBACK_VIEW_PARAMS, FEEDBACK_ID_PARAM] as const;

/** Checkbox order in the filter bar, and the order statuses are written to the URL in. */
const FEEDBACK_STATUS_ORDER = [FeedbackStatus.New, FeedbackStatus.InProgress, FeedbackStatus.Closed] as const;

// `status` is the checked statuses joined with commas (`New,Closed`). No box checked is a real
// state distinct from the default (it matches nothing; useFeedbackOperations skips the list query),
// so it gets its own token.
const STATUS_SEPARATOR = ',';
const NO_STATUS_TOKEN = 'none';

export type FeedbackSearch = {
  [FEEDBACK_STATUS_PARAM]?: string;
  [FEEDBACK_SUBJECT_PARAM]?: FeedbackSubject;
  [FEEDBACK_ORG_PARAM]?: string[];
  [FEEDBACK_ASC_PARAM]?: true;
  [FEEDBACK_PAGE_PARAM]?: number;
  [FEEDBACK_LIMIT_PARAM]?: number;
};

export type FeedbackView = {
  statusFilters: Record<FeedbackStatus, boolean>;
  /** Undefined is every subject. */
  subject: FeedbackSubject | undefined;
  /** Organization names; empty is every organization. */
  organizations: string[];
  sortAscending: boolean;
  page: number;
  limit: number;
};

const toStatusFilters = (checked: readonly FeedbackStatus[]): Record<FeedbackStatus, boolean> =>
  Object.fromEntries(FEEDBACK_STATUS_ORDER.map(status => [status, checked.includes(status)])) as Record<
    FeedbackStatus,
    boolean
  >;

const checkedStatuses = (statusFilters: Record<FeedbackStatus, boolean>): FeedbackStatus[] =>
  FEEDBACK_STATUS_ORDER.filter(status => statusFilters[status]);

export const DEFAULT_FEEDBACK_VIEW: FeedbackView = {
  statusFilters: toStatusFilters([FeedbackStatus.New]),
  subject: undefined,
  organizations: [],
  sortAscending: false,
  page: 1,
  limit: FEEDBACK_LIST_DEFAULT_LIMIT,
};

const isFeedbackStatus = (value: string): value is FeedbackStatus =>
  FEEDBACK_STATUS_ORDER.some(status => status === value);

/** The checked statuses a `status` value names, or undefined when it is malformed (one bad token voids it). */
const decodeStatuses = (value: unknown): FeedbackStatus[] | undefined => {
  if (value === NO_STATUS_TOKEN) return [];
  if (typeof value !== 'string' || value === '') return undefined;
  const tokens = value.split(STATUS_SEPARATOR);
  if (!tokens.every(isFeedbackStatus)) return undefined;
  return FEEDBACK_STATUS_ORDER.filter(status => tokens.includes(status));
};

const encodeStatuses = (statuses: readonly FeedbackStatus[]): string =>
  statuses.length === 0 ? NO_STATUS_TOKEN : statuses.join(STATUS_SEPARATOR);

const parseStatus = (value: unknown): string | undefined => {
  const statuses = decodeStatuses(value);
  return statuses && encodeStatuses(statuses);
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return FEEDBACK_PAGE_SIZE_OPTIONS.includes(limit) ? limit : undefined;
};

// Only ever written as `true`; the default (newest first) is the param's absence.
const parseAscending = (value: unknown): true | undefined => (value === true || value === 'true' ? true : undefined);

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const FEEDBACK_SEARCH_PARSERS: {
  readonly [K in keyof FeedbackSearch]-?: (value: unknown) => FeedbackSearch[K];
} = {
  [FEEDBACK_STATUS_PARAM]: parseStatus,
  [FEEDBACK_SUBJECT_PARAM]: oneOf(FEEDBACK_SUBJECTS),
  [FEEDBACK_ORG_PARAM]: parseStringList,
  [FEEDBACK_ASC_PARAM]: parseAscending,
  [FEEDBACK_PAGE_PARAM]: parsePage,
  [FEEDBACK_LIMIT_PARAM]: parseLimit,
};

/** The list view a URL describes; a missing or invalid param means its default. */
export function feedbackViewFromSearch(search: Record<string, unknown>): FeedbackView {
  const statuses = decodeStatuses(search[FEEDBACK_STATUS_PARAM]);
  return {
    statusFilters: statuses ? toStatusFilters(statuses) : DEFAULT_FEEDBACK_VIEW.statusFilters,
    subject: FEEDBACK_SEARCH_PARSERS[FEEDBACK_SUBJECT_PARAM](search[FEEDBACK_SUBJECT_PARAM]),
    organizations: parseStringList(search[FEEDBACK_ORG_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.organizations,
    sortAscending: parseAscending(search[FEEDBACK_ASC_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.sortAscending,
    page: parsePage(search[FEEDBACK_PAGE_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.page,
    limit: parseLimit(search[FEEDBACK_LIMIT_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.limit,
  };
}

/**
 * The view params to write for `view`. Every key is present, and a default is set to undefined so
 * it is removed from the URL: a bare `?tab=feedback` is the default view.
 */
export function feedbackViewToSearch(view: FeedbackView): {
  [K in keyof Required<FeedbackSearch>]: Required<FeedbackSearch>[K] | undefined;
} {
  const statuses = encodeStatuses(checkedStatuses(view.statusFilters));
  const defaultStatuses = encodeStatuses(checkedStatuses(DEFAULT_FEEDBACK_VIEW.statusFilters));
  return {
    [FEEDBACK_STATUS_PARAM]: statuses === defaultStatuses ? undefined : statuses,
    [FEEDBACK_SUBJECT_PARAM]: FEEDBACK_SEARCH_PARSERS[FEEDBACK_SUBJECT_PARAM](view.subject),
    [FEEDBACK_ORG_PARAM]: parseStringList(view.organizations),
    [FEEDBACK_ASC_PARAM]: view.sortAscending ? true : undefined,
    [FEEDBACK_PAGE_PARAM]: view.page === DEFAULT_FEEDBACK_VIEW.page ? undefined : parsePage(view.page),
    [FEEDBACK_LIMIT_PARAM]: view.limit === DEFAULT_FEEDBACK_VIEW.limit ? undefined : parseLimit(view.limit),
  };
}
