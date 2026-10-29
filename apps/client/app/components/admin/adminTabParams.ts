import { INTEGRATION_DEMAND_TAB_PARAMS } from './integrationDemandSearch';
import { SIGNUP_RISK_REVIEW_TAB_PARAMS } from './signupRiskReviewSearch';
import {
  ADMIN_AUDIT_LOG_TAB_SLUG,
  ADMIN_FEEDBACK_TAB_SLUG,
  ADMIN_TAB_PARAM,
  ADMIN_USERS_TAB_SLUG,
  AUDIT_ENTRY_ID_PARAM,
  AuditLogFiltersSchema,
  type AuditLogFilters,
} from '@bike4mind/common';
import { optionalStringSearchValue } from '@client/app/utils/optionalStringSearchValue';
import { FEEDBACK_SEARCH_PARSERS, FEEDBACK_TAB_PARAMS, type FeedbackSearch } from './Feedback/feedbackTabSearch';
import { USERS_SEARCH_PARSERS, USERS_TAB_PARAMS, type UsersSearch } from './Users/usersTabSearch';
import {
  WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS,
  WEBHOOK_AUDIT_LOGS_TAB_PARAMS,
  type WebhookAuditLogsSearch,
} from './WebhookAuditLogs/webhookAuditLogsTabSearch';
import { MODEL_LOGS_SEARCH_PARSERS, MODEL_LOGS_TAB_PARAMS, type ModelLogsSearch } from './modelLogsTabSearch';
import {
  ADMIN_ORGANIZATIONS_TAB_SLUG,
  ORGS_SEARCH_PARSERS,
  ORGS_TAB_PARAMS,
  type OrganizationsSearch,
} from './organizationsTabSearch';
import {
  ADMIN_SUBSCRIPTIONS_TAB_SLUG,
  SUBSCRIPTIONS_SEARCH_PARSERS,
  SUBSCRIPTIONS_TAB_PARAMS,
  type SubscriptionsSearch,
} from './Subscriptions/subscriptionsTabSearch';

/**
 * Which `/admin` search params belong to which tab, read by both `validateSearch` (router.tsx) and
 * the tab-switch rebuild (useAdminTabUrlSync.ts). Kept free of AdminTab and the sidebar config,
 * which drag every admin icon into router.tsx's eager import.
 */

export const ADMIN_SETTINGS_TAB_SLUG = 'admin-settings';
export const ADMIN_SETTINGS_SECTION_PARAM = 'section';
export const ADMIN_SETTINGS_SEARCH_PARAM = 'q';
// Slugs that are not in @bike4mind/common, shared with adminTabSlugs.ts.
export const ADMIN_WEBHOOK_AUDIT_LOGS_TAB_SLUG = 'webhook-audit-logs';
export const ADMIN_MODEL_LOGS_TAB_SLUG = 'model-logs';
export const ADMIN_INTEGRATION_DEMAND_TAB_SLUG = 'integration-demand';
export const ADMIN_SIGNUP_RISK_REVIEW_TAB_SLUG = 'signup-risk-review';
export { ADMIN_ORGANIZATIONS_TAB_SLUG, ADMIN_SUBSCRIPTIONS_TAB_SLUG };

const EMERGENCY_ACCESS_PARAM = 'emergency_access';

const AUDIT_LOG_FILTER_PARAMS = Object.keys(AuditLogFiltersSchema.shape) as Array<keyof AuditLogFilters>;

/** Console-wide params: they survive every tab change. */
export const ADMIN_GLOBAL_PARAMS = [EMERGENCY_ACCESS_PARAM, ADMIN_TAB_PARAM] as const;

/**
 * Tab slug -> the params that tab owns; each key has exactly one owner (tested). These URLs get
 * shared and copied into login redirects, so never register tokens, form fields, setting values, or
 * a search over user records. Admin Settings' `q` is fine: it searches config, not people; the Users,
 * Feedback, Model Logs, Organizations, Subscriptions and Risk review tabs' free-text searches are left out for
 * exactly that reason.
 */
export const ADMIN_TAB_PARAMS = {
  [ADMIN_USERS_TAB_SLUG]: USERS_TAB_PARAMS,
  [ADMIN_FEEDBACK_TAB_SLUG]: FEEDBACK_TAB_PARAMS,
  [ADMIN_AUDIT_LOG_TAB_SLUG]: [...AUDIT_LOG_FILTER_PARAMS, AUDIT_ENTRY_ID_PARAM],
  [ADMIN_SETTINGS_TAB_SLUG]: [ADMIN_SETTINGS_SECTION_PARAM, ADMIN_SETTINGS_SEARCH_PARAM],
  [ADMIN_WEBHOOK_AUDIT_LOGS_TAB_SLUG]: WEBHOOK_AUDIT_LOGS_TAB_PARAMS,
  [ADMIN_MODEL_LOGS_TAB_SLUG]: MODEL_LOGS_TAB_PARAMS,
  [ADMIN_INTEGRATION_DEMAND_TAB_SLUG]: INTEGRATION_DEMAND_TAB_PARAMS,
  [ADMIN_ORGANIZATIONS_TAB_SLUG]: ORGS_TAB_PARAMS,
  [ADMIN_SUBSCRIPTIONS_TAB_SLUG]: SUBSCRIPTIONS_TAB_PARAMS,
  [ADMIN_SIGNUP_RISK_REVIEW_TAB_SLUG]: SIGNUP_RISK_REVIEW_TAB_PARAMS,
} as const satisfies Readonly<Record<string, readonly string[]>>;

type AdminTabParam = (typeof ADMIN_TAB_PARAMS)[keyof typeof ADMIN_TAB_PARAMS][number];
type AdminSearchParam = (typeof ADMIN_GLOBAL_PARAMS)[number] | AdminTabParam;

type TypedAdminSearch = UsersSearch &
  FeedbackSearch &
  WebhookAuditLogsSearch &
  ModelLogsSearch &
  OrganizationsSearch &
  SubscriptionsSearch;

/** Params with a typed parser; every other registered param is an optional string. */
export type AdminSearch = Partial<Record<Exclude<AdminSearchParam, keyof TypedAdminSearch>, string>> & TypedAdminSearch;

// A Map so a key read from the registry can never resolve to an inherited object member.
const TYPED_PARAM_PARSERS: ReadonlyMap<string, (value: unknown, search: Record<string, unknown>) => unknown> = new Map(
  Object.entries({
    ...USERS_SEARCH_PARSERS,
    ...FEEDBACK_SEARCH_PARSERS,
    ...WEBHOOK_AUDIT_LOGS_SEARCH_PARSERS,
    ...MODEL_LOGS_SEARCH_PARSERS,
    ...ORGS_SEARCH_PARSERS,
    ...SUBSCRIPTIONS_SEARCH_PARSERS,
  })
);

const parseAdminSearchValue = (key: AdminSearchParam, search: Record<string, unknown>): unknown =>
  (TYPED_PARAM_PARSERS.get(key) ?? optionalStringSearchValue)(search[key], search);

// A Map for the same reason as adminTabSlugs.ts: the slug comes from the query string, and an
// object lookup would resolve `?tab=constructor` to an inherited member.
const PARAMS_BY_TAB_SLUG: ReadonlyMap<string, readonly AdminTabParam[]> = new Map(Object.entries(ADMIN_TAB_PARAMS));

const ALL_ADMIN_SEARCH_PARAMS: readonly AdminSearchParam[] = [
  ...ADMIN_GLOBAL_PARAMS,
  ...Object.values(ADMIN_TAB_PARAMS).flat(),
];

/**
 * The admin route's `validateSearch`. Every registered key is declared (absent ones as undefined),
 * so each tab's params are typed and survive validation.
 */
export function parseAdminSearch(search: Record<string, unknown>): AdminSearch {
  return Object.fromEntries(
    ALL_ADMIN_SEARCH_PARAMS.map(key => [key, parseAdminSearchValue(key, search)])
  ) as AdminSearch;
}

/**
 * The search to write when the console switches to `slug`: the console-wide params plus only that
 * tab's own, so the previous tab's state and stray params (a leftover login redirectTo) are dropped.
 * Every other registered key is set to undefined rather than omitted, so it is removed from the URL.
 */
export function adminSearchForTab(previous: Record<string, unknown>, slug: string): AdminSearch {
  const kept = new Set<string>([...ADMIN_GLOBAL_PARAMS, ...(PARAMS_BY_TAB_SLUG.get(slug) ?? [])]);
  const search = Object.fromEntries(
    ALL_ADMIN_SEARCH_PARAMS.map(key => [key, kept.has(key) ? parseAdminSearchValue(key, previous) : undefined])
  ) as AdminSearch;
  return { ...search, [ADMIN_TAB_PARAM]: slug };
}
