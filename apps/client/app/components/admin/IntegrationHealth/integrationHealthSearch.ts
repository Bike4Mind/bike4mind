import { oneOf } from '../adminSearchValues';

/**
 * The Integration Health tab's `/admin` search params. Pure and React-free: adminTabParams.ts (and
 * through it router.tsx's eager import) reads it. Registered as plain strings so an invalid value
 * reaches the tab, which falls back to the default instead of having it stripped before mount.
 */

export const ADMIN_INTEGRATION_HEALTH_TAB_SLUG = 'integration-health';

export const INTEGRATION_HEALTH_TIME_RANGES = ['24h', '7d', '30d'] as const;
export const INTEGRATION_NAMES = ['slack', 'github', 'jira', 'confluence'] as const;

export type TimeRange = (typeof INTEGRATION_HEALTH_TIME_RANGES)[number];
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

export const DEFAULT_INTEGRATION_HEALTH_TIME_RANGE: TimeRange = '24h';

export const INTEGRATION_HEALTH_SEARCH_PARAMS = {
  timeRange: 'healthRange',
  expandedIntegration: 'healthIntegration',
} as const;

export const INTEGRATION_HEALTH_TAB_PARAMS = Object.values(INTEGRATION_HEALTH_SEARCH_PARAMS);

export type IntegrationHealthSearchState = {
  timeRange: TimeRange;
  expandedIntegration: IntegrationName | null;
};

const parseTimeRange = oneOf(INTEGRATION_HEALTH_TIME_RANGES);
const parseIntegrationName = oneOf(INTEGRATION_NAMES);

export const readIntegrationHealthSearch = (search: Record<string, unknown>): IntegrationHealthSearchState => ({
  timeRange:
    parseTimeRange(search[INTEGRATION_HEALTH_SEARCH_PARAMS.timeRange]) ?? DEFAULT_INTEGRATION_HEALTH_TIME_RANGE,
  expandedIntegration: parseIntegrationName(search[INTEGRATION_HEALTH_SEARCH_PARAMS.expandedIntegration]) ?? null,
});

/** The URL entries for a state: defaults and a collapsed list are written as undefined, which removes them. */
export const integrationHealthSearchEntries = (
  state: IntegrationHealthSearchState
): Record<string, string | undefined> => ({
  [INTEGRATION_HEALTH_SEARCH_PARAMS.timeRange]:
    state.timeRange === DEFAULT_INTEGRATION_HEALTH_TIME_RANGE ? undefined : state.timeRange,
  [INTEGRATION_HEALTH_SEARCH_PARAMS.expandedIntegration]: state.expandedIntegration ?? undefined,
});
