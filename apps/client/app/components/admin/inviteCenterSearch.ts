import { oneOf } from './adminSearchValues';

// `section` belongs to Admin Settings, and each registered param key needs exactly one owner (adminTabParams.ts).
export const INVITE_CENTER_SECTION_PARAM = 'inviteSection';
export const INVITE_CENTER_SECTION_IDS = ['waitlist', 'packages', 'schedule', 'pending', 'rewards'] as const;
export type InviteCenterSectionId = (typeof INVITE_CENTER_SECTION_IDS)[number];
export const DEFAULT_INVITE_CENTER_SECTION: InviteCenterSectionId = 'waitlist';

export const PENDING_STATUS_PARAM = 'pendingStatus';
export const PENDING_REASON_PARAM = 'pendingReason';
export const PENDING_SOURCE_PARAM = 'pendingSource';
export const PENDING_SORT_PARAM = 'pendingSort';
export const PENDING_STATUSES = ['held', 'dripping', 'blocked'] as const;
export const PENDING_HELD_REASONS = ['budget_exhausted', 'risk_review'] as const;
export const PENDING_SOURCES = ['default', 'package'] as const;
export const PENDING_SORTS = ['oldest', 'remaining'] as const;

// The query and view keys are never written: the Pending list has no search box and no saved views.
export const PENDING_SEARCH_KEYS = {
  query: 'pendingQuery',
  view: 'pendingView',
  filters: {
    status: PENDING_STATUS_PARAM,
    heldReason: PENDING_REASON_PARAM,
    source: PENDING_SOURCE_PARAM,
    sort: PENDING_SORT_PARAM,
  },
};

export const INVITE_CENTER_TAB_PARAMS = [
  INVITE_CENTER_SECTION_PARAM,
  PENDING_STATUS_PARAM,
  PENDING_REASON_PARAM,
  PENDING_SOURCE_PARAM,
  PENDING_SORT_PARAM,
] as const;

export type InviteCenterSearch = {
  [INVITE_CENTER_SECTION_PARAM]?: InviteCenterSectionId;
  [PENDING_STATUS_PARAM]?: (typeof PENDING_STATUSES)[number];
  [PENDING_REASON_PARAM]?: (typeof PENDING_HELD_REASONS)[number];
  [PENDING_SOURCE_PARAM]?: (typeof PENDING_SOURCES)[number];
  [PENDING_SORT_PARAM]?: (typeof PENDING_SORTS)[number];
};

/** Per-key coercion for the route's `validateSearch`; an unknown section becomes undefined. */
export const INVITE_CENTER_SEARCH_PARSERS: {
  readonly [K in keyof InviteCenterSearch]-?: (value: unknown) => InviteCenterSearch[K];
} = {
  [INVITE_CENTER_SECTION_PARAM]: oneOf(INVITE_CENTER_SECTION_IDS),
  [PENDING_STATUS_PARAM]: oneOf(PENDING_STATUSES),
  [PENDING_REASON_PARAM]: oneOf(PENDING_HELD_REASONS),
  [PENDING_SOURCE_PARAM]: oneOf(PENDING_SOURCES),
  [PENDING_SORT_PARAM]: oneOf(PENDING_SORTS),
};
