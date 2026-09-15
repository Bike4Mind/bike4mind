import { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import type { EventMetric, SortField, SortDirection } from '../types';

export const useEventMetricsState = (metrics: EventMetric[]) => {
  // Filter states
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
    setDateFrom('');
    setDateTo('');
    setUserFilter('');
    setEventFilter('');
    setEventCategoryFilter('');
  };

  const setDateRange = (preset: string) => {
    const now = dayjs();
    switch (preset) {
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
