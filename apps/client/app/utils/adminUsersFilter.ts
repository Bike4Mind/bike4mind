import { z } from 'zod';
import type { AdminUserListItem } from './adminUserProjection';
import type { EmailDomainGroup } from './signupAnomaly';

/**
 * The admin users list's filter contract, shared by the list page, GET /api/admin/users and the
 * bulk endpoint's "all matching" target, so a bulk action re-resolves exactly the rows the admin saw.
 * Pure and React-free: the server imports it.
 */

export const USER_STATUS_FILTERS = ['active', 'suspended', 'restricted'] as const;
export const USER_PLAN_FILTERS = ['DemoUser', 'PaidUser', 'VIPUser', 'ManagerUser', 'AdminUser'] as const;
/** `email` means no external identity provider. */
export const USER_SIGNUP_METHOD_FILTERS = ['email', 'google', 'github', 'facebook', 'okta', 'saml'] as const;
export const USER_SIGNED_UP_FILTERS = ['hour', 'day', 'week', 'month'] as const;
export const USER_RISK_FILTERS = ['high', 'medium', 'low'] as const;
export const YES_NO_FILTERS = ['yes', 'no'] as const;
/** The signup verdict the analytics charts split on; unclassified accounts are in neither. */
export const USER_VERDICT_FILTERS = ['suspected', 'legit'] as const;
/** Activation funnel steps in order; a filter on one selects users who reached it and not the next. */
export const USER_FUNNEL_STEP_FILTERS = ['signedUp', 'firstAction', 'cameBack', 'paid'] as const;
export type UserFunnelStep = (typeof USER_FUNNEL_STEP_FILTERS)[number];

export const ADMIN_USERS_SORT_FIELDS = ['createdAt', 'name', 'currentCredits', 'lastActiveAt'] as const;
export type AdminUsersSortField = (typeof ADMIN_USERS_SORT_FIELDS)[number];

/** Milliseconds per `signedUp` window. */
export const SIGNED_UP_WINDOW_MS: Record<(typeof USER_SIGNED_UP_FILTERS)[number], number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
};

/** Accounts younger than this read as New rather than Active. */
export const NEW_ACCOUNT_WINDOW_MS = SIGNED_UP_WINDOW_MS.week;

/**
 * Signup assessment bands as risk. The band is the only stored per-account risk signal today; a
 * missing assessment is no signal, not low risk.
 */
export const RISK_BAND: Record<(typeof USER_RISK_FILTERS)[number], 'review' | 'reduced' | 'full'> = {
  high: 'review',
  medium: 'reduced',
  low: 'full',
};

const DAY_MS = 86_400_000;
/**
 * Longest created window `verdict` and `funnelStep` accept: both classify every signup in it live, and a
 * monthly bucket of the 12-month analytics chart has to fit.
 */
export const COHORT_WINDOW_MAX_DAYS = 93;
/** Longest `activeFrom`..`activeTo` span, both ends inclusive. */
export const ACTIVE_WINDOW_MAX_DAYS = 366;

/** A UTC day as analytics_user_days stores it (`YYYY-MM-DD`), and a real calendar date. */
export const isUtcDay = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
};

const utcDay = z.string().refine(isUtcDay, 'Must be a UTC day as YYYY-MM-DD');

// Routes pass this as qs's arrayLimit too: past qs's default of 20, a list parses as an object.
export const ADMIN_USERS_LIST_MAX = 50;

// A query string carries a one-item list as a bare string.
const stringList = z.preprocess(
  value => (typeof value === 'string' ? [value] : value),
  z.array(z.string().max(200)).max(ADMIN_USERS_LIST_MAX)
);

/** The filter fields without the cross-field rules; extend this, then apply refineAdminUsersFilter. */
export const AdminUsersFilterFieldsSchema = z.object({
  search: z.string().trim().max(500).optional(),
  orgSearch: stringList.optional(),
  tags: stringList.optional(),
  status: z.enum(USER_STATUS_FILTERS).optional(),
  plan: z.enum(USER_PLAN_FILTERS).optional(),
  emailDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9.-]{1,253}$/, 'Not a valid domain')
    .optional(),
  signupMethod: z.enum(USER_SIGNUP_METHOD_FILTERS).optional(),
  verified: z.enum(YES_NO_FILTERS).optional(),
  hasApiKey: z.enum(YES_NO_FILTERS).optional(),
  signedUp: z.enum(USER_SIGNED_UP_FILTERS).optional(),
  risk: z.enum(USER_RISK_FILTERS).optional(),
  // A created-at window from the signup chart; the end is exclusive.
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  // Classified live over the created window, which both need.
  verdict: z.enum(USER_VERDICT_FILTERS).optional(),
  funnelStep: z.enum(USER_FUNNEL_STEP_FILTERS).optional(),
  // UTC days with AI activity, both ends inclusive; set together.
  activeFrom: utcDay.optional(),
  activeTo: utcDay.optional(),
});

/** Rules across fields, shared by every schema built on AdminUsersFilterFieldsSchema. */
export function refineAdminUsersFilter(filter: z.infer<typeof AdminUsersFilterFieldsSchema>, ctx: z.RefinementCtx) {
  const cohortKeys = (['verdict', 'funnelStep'] as const).filter(key => filter[key] !== undefined);
  if (cohortKeys.length > 0) {
    if (!filter.createdFrom || !filter.createdTo) {
      for (const key of cohortKeys) {
        ctx.addIssue({ code: 'custom', path: [key], message: `${key} needs both createdFrom and createdTo` });
      }
    } else {
      const span = Date.parse(filter.createdTo) - Date.parse(filter.createdFrom);
      if (span <= 0 || span > COHORT_WINDOW_MAX_DAYS * DAY_MS) {
        ctx.addIssue({
          code: 'custom',
          path: ['createdTo'],
          message: `With ${cohortKeys.join(' or ')}, the created window must end after it starts and span at most ${COHORT_WINDOW_MAX_DAYS} days`,
        });
      }
    }
  }
  if (filter.activeFrom === undefined && filter.activeTo === undefined) return;
  if (filter.activeFrom === undefined || filter.activeTo === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: [filter.activeFrom === undefined ? 'activeFrom' : 'activeTo'],
      message: 'activeFrom and activeTo must be set together',
    });
    return;
  }
  // The field check already reported a malformed day; zod still runs this refinement.
  if (!isUtcDay(filter.activeFrom) || !isUtcDay(filter.activeTo)) return;
  const days = (Date.parse(filter.activeTo) - Date.parse(filter.activeFrom)) / DAY_MS + 1;
  if (days < 1) {
    ctx.addIssue({ code: 'custom', path: ['activeTo'], message: 'activeTo must not be before activeFrom' });
  } else if (days > ACTIVE_WINDOW_MAX_DAYS) {
    ctx.addIssue({
      code: 'custom',
      path: ['activeTo'],
      message: `The active window may span at most ${ACTIVE_WINDOW_MAX_DAYS} days`,
    });
  }
}

export const AdminUsersFilterSchema = AdminUsersFilterFieldsSchema.superRefine(refineAdminUsersFilter);
export type AdminUsersFilter = z.infer<typeof AdminUsersFilterSchema>;

export const ADMIN_USERS_PAGE_SIZES = [25, 50, 100] as const;

const pageSize = z.coerce
  .number()
  .int()
  .refine(value => (ADMIN_USERS_PAGE_SIZES as readonly number[]).includes(value), 'Page size must be 25, 50 or 100');

/** GET /api/admin/users. `groupBy=emailDomain` returns domain groups for the filter instead of a page. */
export const AdminUsersQuerySchema = AdminUsersFilterFieldsSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: pageSize.default(25),
  sortField: z.enum(ADMIN_USERS_SORT_FIELDS).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  groupBy: z.enum(['emailDomain']).optional(),
}).superRefine(refineAdminUsersFilter);

export type AdminUsersListParams = Omit<z.infer<typeof AdminUsersQuerySchema>, 'groupBy'>;

/** A list row: the admin projection plus figures computed for the page's users only. */
export type AdminUsersListRow = AdminUserListItem & {
  /** The first identity provider the account was linked to, or `email`. */
  signupMethod: string;
  apiKeyCount: number;
  /** Credits used in the last 30 days (usage ledger rows), or null when the ledger read failed. */
  spend30d: number | null;
};

export type AdminUsersListResponse = {
  users: AdminUsersListRow[];
  totalUsers: number;
  page: number;
  totalPages: number;
};

export type AdminUsersDomainGroupsResponse = {
  groups: EmailDomainGroup[];
  groupsTruncated: boolean;
  keysTruncated: boolean;
};

/** Counts behind the page header and the built-in saved views. */
export type AdminUsersSummary = {
  total: number;
  activeThisWeek: number;
  views: { newThisWeek: number; highRisk: number; suspended: number };
};
