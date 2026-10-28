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

// Routes pass this as qs's arrayLimit too: past qs's default of 20, a list parses as an object.
export const ADMIN_USERS_LIST_MAX = 50;

// A query string carries a one-item list as a bare string.
const stringList = z.preprocess(
  value => (typeof value === 'string' ? [value] : value),
  z.array(z.string().max(200)).max(ADMIN_USERS_LIST_MAX)
);

export const AdminUsersFilterSchema = z.object({
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
});
export type AdminUsersFilter = z.infer<typeof AdminUsersFilterSchema>;

export const ADMIN_USERS_PAGE_SIZES = [25, 50, 100] as const;

const pageSize = z.coerce
  .number()
  .int()
  .refine(value => (ADMIN_USERS_PAGE_SIZES as readonly number[]).includes(value), 'Page size must be 25, 50 or 100');

/** GET /api/admin/users. `groupBy=emailDomain` returns domain groups for the filter instead of a page. */
export const AdminUsersQuerySchema = AdminUsersFilterSchema.extend({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: pageSize.default(25),
  sortField: z.enum(ADMIN_USERS_SORT_FIELDS).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  groupBy: z.enum(['emailDomain']).optional(),
});

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
