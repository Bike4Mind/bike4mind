import { useState, useMemo } from 'react';
import type { RateLimitSnapshot } from '../types';

export const useRateLimitMetricsState = (snapshots: RateLimitSnapshot[]) => {
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [integrationFilter, setIntegrationFilter] = useState<string>('');
  const [throttledOnly, setThrottledOnly] = useState(false);

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
