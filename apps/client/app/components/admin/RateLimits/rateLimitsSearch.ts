import { RATE_LIMIT_INTEGRATIONS, type RateLimitIntegrationType } from '@bike4mind/common';
import { oneOf } from '../adminSearchValues';

/**
 * The Rate Limits tab's `/admin` search params: the APPLIED filters and the sub-tab. The draft in the
 * control panel stays local until Apply. Pure and React-free: adminTabParams.ts (and through it
 * router.tsx's eager import) reads it. Registered as plain strings so an invalid value reaches the
 * tab, which falls back to the default instead of having it stripped before mount.
 */

export const ADMIN_RATE_LIMITS_TAB_SLUG = 'rate-limits';

export const RATE_LIMITS_VIEWS = ['overview', 'raw'] as const;
export type RateLimitsView = (typeof RATE_LIMITS_VIEWS)[number];
export const DEFAULT_RATE_LIMITS_VIEW: RateLimitsView = 'overview';

export const RATE_LIMITS_SEARCH_PARAMS = {
  dateFrom: 'rateFrom',
  dateTo: 'rateTo',
  integration: 'rateIntegration',
  throttledOnly: 'rateThrottled',
  view: 'rateView',
} as const;

export const RATE_LIMITS_TAB_PARAMS = Object.values(RATE_LIMITS_SEARCH_PARAMS);

export type RateLimitsSearchState = {
  dateFrom: string;
  dateTo: string;
  integration: RateLimitIntegrationType | '';
  throttledOnly: boolean;
  view: RateLimitsView;
};

export const DEFAULT_RATE_LIMITS_SEARCH_STATE: RateLimitsSearchState = {
  dateFrom: '',
  dateTo: '',
  integration: '',
  throttledOnly: false,
  view: DEFAULT_RATE_LIMITS_VIEW,
};

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;

// A UTC timestamp, normalized to the toISOString() form the control panel writes; anything else is dropped.
// The prefix check rejects `2026-02-30T...`, which Date would roll into March.
export const parseIsoDateTime = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !ISO_DATE_TIME.test(value)) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  const normalized = date.toISOString();
  return normalized.startsWith(value.slice(0, 16)) ? normalized : undefined;
};

const parseIntegration = oneOf(RATE_LIMIT_INTEGRATIONS);
const parseView = oneOf(RATE_LIMITS_VIEWS);

// TanStack's JSON search parser hands `true` back as a boolean, and validateSearch then stringifies it.
const parseThrottledOnly = (value: unknown): boolean => value === true || value === 'true';

export const readRateLimitsSearch = (search: Record<string, unknown>): RateLimitsSearchState => ({
  dateFrom: parseIsoDateTime(search[RATE_LIMITS_SEARCH_PARAMS.dateFrom]) ?? '',
  dateTo: parseIsoDateTime(search[RATE_LIMITS_SEARCH_PARAMS.dateTo]) ?? '',
  integration: parseIntegration(search[RATE_LIMITS_SEARCH_PARAMS.integration]) ?? '',
  throttledOnly: parseThrottledOnly(search[RATE_LIMITS_SEARCH_PARAMS.throttledOnly]),
  view: parseView(search[RATE_LIMITS_SEARCH_PARAMS.view]) ?? DEFAULT_RATE_LIMITS_VIEW,
});

/** The URL entries for a state: every default is written as undefined, which removes it. */
export const rateLimitsSearchEntries = (
  state: RateLimitsSearchState
): Record<string, string | boolean | undefined> => ({
  [RATE_LIMITS_SEARCH_PARAMS.dateFrom]: state.dateFrom || undefined,
  [RATE_LIMITS_SEARCH_PARAMS.dateTo]: state.dateTo || undefined,
  [RATE_LIMITS_SEARCH_PARAMS.integration]: state.integration || undefined,
  [RATE_LIMITS_SEARCH_PARAMS.throttledOnly]: state.throttledOnly || undefined,
  [RATE_LIMITS_SEARCH_PARAMS.view]: state.view === DEFAULT_RATE_LIMITS_VIEW ? undefined : state.view,
});
