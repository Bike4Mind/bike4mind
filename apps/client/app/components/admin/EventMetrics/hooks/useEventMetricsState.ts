import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { SEARCH_TERM_URL_DEBOUNCE_MS } from '../../shared/useAdminListUrlState';
import type { EventMetric, SortField, SortDirection } from '../types';
import type { MetricsFilters } from './useEventMetrics';

/** `all` sets no date bounds; `custom` keeps the current bounds for the From and To inputs to edit. */
export type DateRangePreset =
  'all' | 'today' | 'yesterday' | 'last7days' | 'last30days' | 'last90days' | 'thisMonth' | 'lastMonth' | 'custom';

/**
 * Applies the picked filters once they have settled for SEARCH_TERM_URL_DEBOUNCE_MS: a filter takes
 * effect without an Apply button, and typing a date does not fetch on every keystroke.
 */
export const useApplyPickedFilters = (filters: MetricsFilters, apply: (filters: MetricsFilters) => void) => {
  const { dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter } = filters;
  useEffect(() => {
    const timer = setTimeout(
      () =>
        apply({
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          userFilter: userFilter || undefined,
          eventFilter: eventFilter || undefined,
          eventCategoryFilter: eventCategoryFilter || undefined,
        }),
      SEARCH_TERM_URL_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter, apply]);
};

export const useEventMetricsState = (metrics: EventMetric[]) => {
  // Filter states
  const [dateRange, setDateRangePreset] = useState<DateRangePreset>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [userFilter, setUserFilter] = useState<string>('');
  const [eventFilter, setEventFilter] = useState<string>('');
  const [eventCategoryFilter, setEventCategoryFilter] = useState<string>('');

  // UI states
  const [activeTab, setActiveTab] = useState<string>('overview');
  const [showInfoModal, setShowInfoModal] = useState<boolean>(false);

  // Sort states
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  const filteredAndSortedMetrics = useMemo(() => {
    const safeMetrics = Array.isArray(metrics) ? metrics : [];
    const filtered = [...safeMetrics];

    filtered.sort((a, b) => {
      let aVal: any;
      let bVal: any;

      switch (sortField) {
        case 'timestamp':
          aVal = new Date(a.timestamp).getTime();
          bVal = new Date(b.timestamp).getTime();
          break;
        case 'eventName':
          aVal = a.eventName;
          bVal = b.eventName;
          break;
        case 'eventCategory':
          aVal = a.eventCategory;
          bVal = b.eventCategory;
          break;
        case 'userName':
          aVal = a.user.userName;
          bVal = b.user.userName;
          break;
        case 'counterValue':
          aVal = a.counterValue;
          bVal = b.counterValue;
          break;
        default:
          aVal = 0;
          bVal = 0;
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return filtered;
  }, [metrics, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const clearFilters = () => {
    setDateRangePreset('all');
    setDateFrom('');
    setDateTo('');
    setUserFilter('');
    setEventFilter('');
    setEventCategoryFilter('');
  };

  const setDateRange = (preset: DateRangePreset) => {
    setDateRangePreset(preset);
    const now = dayjs();
    switch (preset) {
      case 'all':
        setDateFrom('');
        setDateTo('');
        break;
      case 'today':
        setDateFrom(now.startOf('day').toISOString());
        setDateTo(now.endOf('day').toISOString());
        break;
      case 'yesterday':
        setDateFrom(now.subtract(1, 'day').startOf('day').toISOString());
        setDateTo(now.subtract(1, 'day').endOf('day').toISOString());
        break;
      case 'last7days':
        setDateFrom(now.subtract(7, 'days').startOf('day').toISOString());
        setDateTo(now.endOf('day').toISOString());
        break;
      case 'last30days':
        setDateFrom(now.subtract(30, 'days').startOf('day').toISOString());
        setDateTo(now.endOf('day').toISOString());
        break;
      case 'last90days':
        setDateFrom(now.subtract(90, 'days').startOf('day').toISOString());
        setDateTo(now.endOf('day').toISOString());
        break;
      case 'thisMonth':
        setDateFrom(now.startOf('month').toISOString());
        setDateTo(now.endOf('month').toISOString());
        break;
      case 'lastMonth':
        setDateFrom(now.subtract(1, 'month').startOf('month').toISOString());
        setDateTo(now.subtract(1, 'month').endOf('month').toISOString());
        break;
    }
  };

  return {
    // Filter states
    dateRange,
    dateFrom,
    dateTo,
    userFilter,
    eventFilter,
    eventCategoryFilter,
    setDateFrom,
    setDateTo,
    setUserFilter,
    setEventFilter,
    setEventCategoryFilter,
    // UI states
    activeTab,
    setActiveTab,
    showInfoModal,
    setShowInfoModal,
    // Sort states
    sortField,
    sortDirection,
    // Computed data
    filteredAndSortedMetrics,
    // Helper functions
    handleSort,
    clearFilters,
    setDateRange,
  };
};
