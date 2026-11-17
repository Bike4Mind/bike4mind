import { useState, useMemo, useEffect } from 'react';
import type { RateLimitSnapshot } from '../types';
import type { RateLimitsSearchState } from '../rateLimitsSearch';

export type RateLimitDraftFilters = Pick<
  RateLimitsSearchState,
  'dateFrom' | 'dateTo' | 'integration' | 'throttledOnly'
>;

/**
 * The control panel's draft filters, seeded from the applied (URL) filters and re-synced whenever those change.
 * Edits stay local until the caller applies them.
 */
export const useRateLimitMetricsState = (snapshots: RateLimitSnapshot[], applied: RateLimitDraftFilters) => {
  const [dateFrom, setDateFrom] = useState<string>(applied.dateFrom);
  const [dateTo, setDateTo] = useState<string>(applied.dateTo);
  const [integrationFilter, setIntegrationFilter] = useState<string>(applied.integration);
  const [throttledOnly, setThrottledOnly] = useState(applied.throttledOnly);

  const {
    dateFrom: appliedFrom,
    dateTo: appliedTo,
    integration: appliedIntegration,
    throttledOnly: appliedThrottled,
  } = applied;
  useEffect(() => {
    setDateFrom(appliedFrom);
    setDateTo(appliedTo);
    setIntegrationFilter(appliedIntegration);
    setThrottledOnly(appliedThrottled);
  }, [appliedFrom, appliedTo, appliedIntegration, appliedThrottled]);

  // Server already filters by integration and throttledOnly via query params;
  // no need to duplicate filtering on the client side.
  const filteredSnapshots = snapshots;

  const summaryStats = useMemo(() => {
    const total = filteredSnapshots.length;
    const throttled = filteredSnapshots.filter(s => s.wasThrottled).length;
    const withUsage = filteredSnapshots.filter(s => s.usagePercent !== null);
    const avgUsage =
      withUsage.length > 0
        ? Math.round(withUsage.reduce((sum, s) => sum + (s.usagePercent ?? 0), 0) / withUsage.length)
        : 0;
    return { total, throttled, avgUsage };
  }, [filteredSnapshots]);

  const clearFilters = () => {
    setDateFrom('');
    setDateTo('');
    setIntegrationFilter('');
    setThrottledOnly(false);
  };

  const setDateRange = (from: string, to: string) => {
    setDateFrom(from);
    setDateTo(to);
  };

  return {
    dateFrom,
    dateTo,
    integrationFilter,
    throttledOnly,
    setDateFrom,
    setDateTo,
    setIntegrationFilter,
    setThrottledOnly,
    filteredSnapshots,
    summaryStats,
    clearFilters,
    setDateRange,
  };
};
