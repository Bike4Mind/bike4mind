import {
  ANALYTICS_ACCOUNTS,
  ANALYTICS_COMPARE,
  ANALYTICS_DEFAULTS,
  ANALYTICS_RANGES,
  ANALYTICS_SIGNUPS,
  type AnalyticsAccounts,
  type AnalyticsCompare,
  type AnalyticsOverviewQuery,
  type AnalyticsRange,
  type AnalyticsSignupsMode,
} from '@client/app/utils/analyticsOverview';
import {
  ACQUISITION_CONVERSION_WINDOWS,
  ACQUISITION_FOLLOW_UPS,
  ACQUISITION_TOUCHES,
  type AcquisitionQuery,
} from '@client/app/utils/acquisitionConversion';

// Query and saved view are unused: only the toolbar's filters are written to the URL. The custom
// bounds are `start`/`end` because the Audit log tab already owns `from`/`to` (see adminTabParams.ts).
export const ANALYTICS_SEARCH_KEYS = {
  query: 'analyticsQuery',
  view: 'analyticsView',
  filters: {
    range: 'range',
    from: 'start',
    to: 'end',
    compare: 'compare',
    signups: 'signups',
    accounts: 'accounts',
    // Not `acq*`: the Users tab owns those for the acquisition drill-down, and each key has one owner.
    touch: 'acquisitionTouch',
    window: 'conversionWindow',
    followUp: 'followUp',
  },
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
    accounts: pick<AnalyticsAccounts>(ANALYTICS_ACCOUNTS, filters.accounts, ANALYTICS_DEFAULTS.accounts),
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
    accounts: query.accounts === ANALYTICS_DEFAULTS.accounts ? '' : query.accounts,
  };
}

export type AcquisitionControls = Pick<AcquisitionQuery, 'touch' | 'window' | 'followUp'>;
const ACQUISITION_DEFAULTS: AcquisitionControls = { touch: 'first', window: '30', followUp: '90' };

/** The acquisition section's own controls in the URL; unknown values fall back to the defaults. */
export function readAcquisitionControls(filters: Record<string, string>): AcquisitionControls {
  return {
    touch: pick(ACQUISITION_TOUCHES, filters.touch, ACQUISITION_DEFAULTS.touch),
    window: pick(ACQUISITION_CONVERSION_WINDOWS, filters.window, ACQUISITION_DEFAULTS.window),
    followUp: pick(ACQUISITION_FOLLOW_UPS, filters.followUp, ACQUISITION_DEFAULTS.followUp),
  };
}

export function writeAcquisitionControls(controls: AcquisitionControls): Record<string, string> {
  return {
    touch: controls.touch === ACQUISITION_DEFAULTS.touch ? '' : controls.touch,
    window: controls.window === ACQUISITION_DEFAULTS.window ? '' : controls.window,
    followUp: controls.followUp === ACQUISITION_DEFAULTS.followUp ? '' : controls.followUp,
  };
}
