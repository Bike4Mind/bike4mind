import {
  ANALYTICS_COMPARE,
  ANALYTICS_DEFAULTS,
  ANALYTICS_RANGES,
  ANALYTICS_SIGNUPS,
  type AnalyticsCompare,
  type AnalyticsOverviewQuery,
  type AnalyticsRange,
  type AnalyticsSignupsMode,
} from '@client/app/utils/analyticsOverview';

// Query and saved view are unused: only the toolbar's filters are written to the URL. The custom
// bounds are `start`/`end` because the Audit log tab already owns `from`/`to` (see adminTabParams.ts).
export const ANALYTICS_SEARCH_KEYS = {
  query: 'analyticsQuery',
  view: 'analyticsView',
  filters: { range: 'range', from: 'start', to: 'end', compare: 'compare', signups: 'signups' },
} as const;
export const ANALYTICS_TAB_PARAMS = Object.values(ANALYTICS_SEARCH_KEYS.filters);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const pick = <T extends string>(values: readonly T[], value: string | undefined, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/** The toolbar state in the URL; unknown values fall back to the defaults, `from`/`to` only apply to custom. */
export function readAnalyticsFilters(filters: Record<string, string>): AnalyticsOverviewQuery {
  const range = pick<AnalyticsRange>(ANALYTICS_RANGES, filters.range, ANALYTICS_DEFAULTS.range);
  return {
    range,
    ...(range === 'custom' && DAY.test(filters.from ?? '') ? { from: filters.from } : {}),
    ...(range === 'custom' && DAY.test(filters.to ?? '') ? { to: filters.to } : {}),
    compare: pick<AnalyticsCompare>(ANALYTICS_COMPARE, filters.compare, ANALYTICS_DEFAULTS.compare),
    signups: pick<AnalyticsSignupsMode>(ANALYTICS_SIGNUPS, filters.signups, ANALYTICS_DEFAULTS.signups),
  };
}

/** The URL filters for a query: defaults are left out so a plain `?tab=analytics` stays the default view. */
export function writeAnalyticsFilters(query: AnalyticsOverviewQuery): Record<string, string> {
  return {
    range: query.range === ANALYTICS_DEFAULTS.range ? '' : query.range,
    from: query.range === 'custom' ? (query.from ?? '') : '',
    to: query.range === 'custom' ? (query.to ?? '') : '',
    compare: query.compare === ANALYTICS_DEFAULTS.compare ? '' : query.compare,
    signups: query.signups === ANALYTICS_DEFAULTS.signups ? '' : query.signups,
  };
}
