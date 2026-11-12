import {
  FEEDBACK_ID_PARAM,
  FEEDBACK_SUBJECTS,
  FeedbackStatus,
  FeedbackType,
  type FeedbackSubject,
} from '@bike4mind/common';
import { oneOf, parseCalendarDate, parseObjectId, parsePage, parseStringList, toNumber } from '../adminSearchValues';
import {
  FEEDBACK_DEFAULT_PAGE_SIZE,
  FEEDBACK_PAGE_SIZE_OPTIONS,
  FEEDBACK_STATUS_ORDER,
  FEEDBACK_TYPE_ORDER,
} from './constants';
import { FEEDBACK_RECEIVED_WINDOWS, type FeedbackReceivedWindow } from './feedbackTrends';

/**
 * The Feedback tab's `/admin` search params and their coercion. Pure and React-free: adminTabParams.ts
 * (and through it router.tsx's eager import) reads it. The free-text search box is deliberately
 * absent - it often holds a username or an email, and these URLs get shared and copied into login
 * redirects. Every param carries a `feedback` prefix because the Users tab already owns the bare
 * names, and the registry gives every param exactly one owner.
 */

export const FEEDBACK_STATUS_PARAM = 'feedbackStatus';
export const FEEDBACK_SUBJECT_PARAM = 'feedbackSubject';
export const FEEDBACK_TYPE_PARAM = 'feedbackType';
export const FEEDBACK_ORG_PARAM = 'feedbackOrg';
export const FEEDBACK_RECEIVED_PARAM = 'feedbackReceived';
export const FEEDBACK_FROM_PARAM = 'feedbackFrom';
export const FEEDBACK_TO_PARAM = 'feedbackTo';
export const FEEDBACK_COMMENT_PARAM = 'feedbackComment';
export const FEEDBACK_ORDER_PARAM = 'feedbackOrder';
export const FEEDBACK_PAGE_PARAM = 'feedbackPage';
export const FEEDBACK_LIMIT_PARAM = 'feedbackLimit';

/** The params that describe the list view; `feedbackId` (the pinned report) is separate. */
const FEEDBACK_VIEW_PARAMS = [
  FEEDBACK_STATUS_PARAM,
  FEEDBACK_SUBJECT_PARAM,
  FEEDBACK_TYPE_PARAM,
  FEEDBACK_ORG_PARAM,
  FEEDBACK_RECEIVED_PARAM,
  FEEDBACK_FROM_PARAM,
  FEEDBACK_TO_PARAM,
  FEEDBACK_COMMENT_PARAM,
  FEEDBACK_ORDER_PARAM,
  FEEDBACK_PAGE_PARAM,
  FEEDBACK_LIMIT_PARAM,
] as const;

export const FEEDBACK_TAB_PARAMS = [...FEEDBACK_VIEW_PARAMS, FEEDBACK_ID_PARAM] as const;

// `feedbackStatus` is the checked statuses joined with commas (`New,Closed`). An empty set has no form:
// the status filter chip checks every status again when its last one is unpicked, and the retired
// `none` token an older link may carry reads as the default.
const STATUS_SEPARATOR = ',';

const FEEDBACK_ORDERS = ['asc', 'desc'] as const;
type FeedbackOrder = (typeof FEEDBACK_ORDERS)[number];

export const FEEDBACK_COMMENT_FILTERS = ['with', 'without'] as const;
export type FeedbackCommentFilter = (typeof FEEDBACK_COMMENT_FILTERS)[number];

export type FeedbackSearch = {
  [FEEDBACK_STATUS_PARAM]?: string;
  [FEEDBACK_SUBJECT_PARAM]?: FeedbackSubject;
  [FEEDBACK_TYPE_PARAM]?: FeedbackType[];
  [FEEDBACK_ORG_PARAM]?: string[];
  [FEEDBACK_RECEIVED_PARAM]?: FeedbackReceivedWindow;
  [FEEDBACK_FROM_PARAM]?: string;
  [FEEDBACK_TO_PARAM]?: string;
  [FEEDBACK_COMMENT_PARAM]?: FeedbackCommentFilter;
  [FEEDBACK_ORDER_PARAM]?: FeedbackOrder;
  [FEEDBACK_PAGE_PARAM]?: number;
  [FEEDBACK_LIMIT_PARAM]?: number;
  [FEEDBACK_ID_PARAM]?: string;
};

export type FeedbackView = {
  statusFilters: Record<FeedbackStatus, boolean>;
  /** Undefined is every subject. */
  subject: FeedbackSubject | undefined;
  /** Report types in severity order; empty is every type. */
  types: FeedbackType[];
  /** Organization names; empty is every organization. */
  organizations: string[];
  /** Undefined is any age. Never set together with `createdFrom`/`createdTo`. */
  received: FeedbackReceivedWindow | undefined;
  /** A custom range of `YYYY-MM-DD` days in the viewer's time zone, both inclusive; either end may be open. */
  createdFrom: string | undefined;
  createdTo: string | undefined;
  /** Undefined is reports with or without a comment. */
  comment: FeedbackCommentFilter | undefined;
  sortAscending: boolean;
  page: number;
  limit: number;
};

export const toStatusFilters = (checked: readonly FeedbackStatus[]): Record<FeedbackStatus, boolean> =>
  Object.fromEntries(FEEDBACK_STATUS_ORDER.map(status => [status, checked.includes(status)])) as Record<
    FeedbackStatus,
    boolean
  >;

export const checkedStatuses = (statusFilters: Record<FeedbackStatus, boolean>): FeedbackStatus[] =>
  FEEDBACK_STATUS_ORDER.filter(status => statusFilters[status]);

export const DEFAULT_FEEDBACK_VIEW: FeedbackView = {
  statusFilters: toStatusFilters([FeedbackStatus.New]),
  subject: undefined,
  types: [],
  organizations: [],
  received: undefined,
  createdFrom: undefined,
  createdTo: undefined,
  comment: undefined,
  sortAscending: false,
  page: 1,
  limit: FEEDBACK_DEFAULT_PAGE_SIZE,
};

const isFeedbackStatus = (value: string): value is FeedbackStatus =>
  FEEDBACK_STATUS_ORDER.some(status => status === value);

/** The checked statuses a `feedbackStatus` value names, or undefined when it is malformed (one bad token voids it). */
const decodeStatuses = (value: unknown): FeedbackStatus[] | undefined => {
  if (typeof value !== 'string' || value === '') return undefined;
  const tokens = value.split(STATUS_SEPARATOR);
  if (!tokens.every(isFeedbackStatus)) return undefined;
  return FEEDBACK_STATUS_ORDER.filter(status => tokens.includes(status));
};

const encodeStatuses = (statuses: readonly FeedbackStatus[]): string | undefined =>
  statuses.length === 0 ? undefined : statuses.join(STATUS_SEPARATOR);

const parseStatus = (value: unknown): string | undefined => {
  const statuses = decodeStatuses(value);
  return statuses && encodeStatuses(statuses);
};

/** The known types a `feedbackType` value names, in severity order; unknown tokens are dropped. */
const parseTypes = (value: unknown): FeedbackType[] | undefined => {
  const tokens = parseStringList(value);
  if (!tokens) return undefined;
  const types = FEEDBACK_TYPE_ORDER.filter(type => tokens.includes(type));
  return types.length > 0 ? types : undefined;
};

const parseLimit = (value: unknown): number | undefined => {
  const limit = toNumber(value);
  return FEEDBACK_PAGE_SIZE_OPTIONS.includes(limit) ? limit : undefined;
};

// Only ever written as 'asc'; the default (newest first) is the param's absence.
const parseOrder = oneOf(FEEDBACK_ORDERS);

/** Per-key coercion for the route's `validateSearch`; anything invalid becomes undefined. */
export const FEEDBACK_SEARCH_PARSERS: {
  readonly [K in keyof FeedbackSearch]-?: (value: unknown) => FeedbackSearch[K];
} = {
  [FEEDBACK_STATUS_PARAM]: parseStatus,
  [FEEDBACK_SUBJECT_PARAM]: oneOf(FEEDBACK_SUBJECTS),
  [FEEDBACK_TYPE_PARAM]: parseTypes,
  [FEEDBACK_ORG_PARAM]: parseStringList,
  [FEEDBACK_RECEIVED_PARAM]: oneOf(FEEDBACK_RECEIVED_WINDOWS),
  [FEEDBACK_FROM_PARAM]: parseCalendarDate,
  [FEEDBACK_TO_PARAM]: parseCalendarDate,
  [FEEDBACK_COMMENT_PARAM]: oneOf(FEEDBACK_COMMENT_FILTERS),
  [FEEDBACK_ORDER_PARAM]: parseOrder,
  [FEEDBACK_PAGE_PARAM]: parsePage,
  [FEEDBACK_LIMIT_PARAM]: parseLimit,
  [FEEDBACK_ID_PARAM]: parseObjectId,
};

/**
 * The custom range a pair of days describes, or none when it is inverted. The Received chip shows a
 * preset or a custom range, never both, so a custom range also voids a preset window.
 */
const parseCreatedRange = (from: unknown, to: unknown): Pick<FeedbackView, 'createdFrom' | 'createdTo'> => {
  const createdFrom = parseCalendarDate(from);
  const createdTo = parseCalendarDate(to);
  // Same-format calendar days, so string order is date order.
  if (createdFrom && createdTo && createdFrom > createdTo) return { createdFrom: undefined, createdTo: undefined };
  return { createdFrom, createdTo };
};

/** The instant a viewer-local calendar day starts (`start`) or ends (`end`, inclusive), as ISO. */
export const calendarDayBoundary = (day: string, boundary: 'start' | 'end'): string =>
  new Date(`${day}T${boundary === 'start' ? '00:00:00.000' : '23:59:59.999'}`).toISOString();

export const hasCreatedRange = (view: Pick<FeedbackView, 'createdFrom' | 'createdTo'>): boolean =>
  view.createdFrom !== undefined || view.createdTo !== undefined;

/** The list view a URL describes; a missing or invalid param means its default. */
export function feedbackViewFromSearch(search: Record<string, unknown>): FeedbackView {
  const statuses = decodeStatuses(search[FEEDBACK_STATUS_PARAM]);
  const range = parseCreatedRange(search[FEEDBACK_FROM_PARAM], search[FEEDBACK_TO_PARAM]);
  return {
    statusFilters: statuses ? toStatusFilters(statuses) : DEFAULT_FEEDBACK_VIEW.statusFilters,
    subject: FEEDBACK_SEARCH_PARSERS[FEEDBACK_SUBJECT_PARAM](search[FEEDBACK_SUBJECT_PARAM]),
    types: parseTypes(search[FEEDBACK_TYPE_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.types,
    organizations: parseStringList(search[FEEDBACK_ORG_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.organizations,
    received: hasCreatedRange(range)
      ? undefined
      : FEEDBACK_SEARCH_PARSERS[FEEDBACK_RECEIVED_PARAM](search[FEEDBACK_RECEIVED_PARAM]),
    ...range,
    comment: FEEDBACK_SEARCH_PARSERS[FEEDBACK_COMMENT_PARAM](search[FEEDBACK_COMMENT_PARAM]),
    sortAscending: search[FEEDBACK_ORDER_PARAM] === 'asc',
    page: parsePage(search[FEEDBACK_PAGE_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.page,
    limit: parseLimit(search[FEEDBACK_LIMIT_PARAM]) ?? DEFAULT_FEEDBACK_VIEW.limit,
  };
}

/**
 * The view params to write for `view`. Every key is present, and a default is set to undefined so
 * it is removed from the URL: a bare `?tab=feedback` is the default view.
 */
export function feedbackViewToSearch(view: FeedbackView): {
  [K in Exclude<keyof FeedbackSearch, typeof FEEDBACK_ID_PARAM>]-?: Required<FeedbackSearch>[K] | undefined;
} {
  const statuses = encodeStatuses(checkedStatuses(view.statusFilters));
  const defaultStatuses = encodeStatuses(checkedStatuses(DEFAULT_FEEDBACK_VIEW.statusFilters));
  const range = parseCreatedRange(view.createdFrom, view.createdTo);
  return {
    [FEEDBACK_STATUS_PARAM]: statuses === defaultStatuses ? undefined : statuses,
    [FEEDBACK_SUBJECT_PARAM]: FEEDBACK_SEARCH_PARSERS[FEEDBACK_SUBJECT_PARAM](view.subject),
    [FEEDBACK_TYPE_PARAM]: parseTypes(view.types),
    [FEEDBACK_ORG_PARAM]: parseStringList(view.organizations),
    [FEEDBACK_RECEIVED_PARAM]: hasCreatedRange(range)
      ? undefined
      : FEEDBACK_SEARCH_PARSERS[FEEDBACK_RECEIVED_PARAM](view.received),
    [FEEDBACK_FROM_PARAM]: range.createdFrom,
    [FEEDBACK_TO_PARAM]: range.createdTo,
    [FEEDBACK_COMMENT_PARAM]: FEEDBACK_SEARCH_PARSERS[FEEDBACK_COMMENT_PARAM](view.comment),
    [FEEDBACK_ORDER_PARAM]: view.sortAscending ? 'asc' : undefined,
    [FEEDBACK_PAGE_PARAM]: view.page === DEFAULT_FEEDBACK_VIEW.page ? undefined : parsePage(view.page),
    [FEEDBACK_LIMIT_PARAM]: view.limit === DEFAULT_FEEDBACK_VIEW.limit ? undefined : parseLimit(view.limit),
  };
}
