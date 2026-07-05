import { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import { ModelMetric, SortField, SortDirection } from '../types';

export const useModelMetricsState = (metrics: ModelMetric[]) => {
  // Filter states
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  // UI states
  const [simplifiedNames, setSimplifiedNames] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [showInfoModal, setShowInfoModal] = useState(false);

  // Sort states
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // Apply filters and sorting
  const filteredAndSortedMetrics = useMemo(() => {
    const filtered = metrics.filter(metric => {
      // Date range filter
      if (dateFrom) {
        const fromDate = dayjs(dateFrom).startOf('day');
        const metricDate = dayjs(metric.timestamp);
        if (metricDate.isBefore(fromDate)) {
          return false;
        }
      }

      if (dateTo) {
        const toDate = dayjs(dateTo).endOf('day');
        const metricDate = dayjs(metric.timestamp);
        if (metricDate.isAfter(toDate)) {
          return false;
        }
      }

      // User filter
      if (userFilter && metric.session?.userId !== userFilter) return false;

      // Model filter
      if (modelFilter && metric.model?.name !== modelFilter) return false;

      // Status filter
      if (statusFilter && metric.status !== statusFilter) return false;

      return true;
    });

    // Apply sorting
    filtered.sort((a, b) => {
      let aVal: any, bVal: any;

      switch (sortField) {
        case 'timestamp':
          aVal = dayjs(a.timestamp).unix();
          bVal = dayjs(b.timestamp).unix();
          break;
        case 'model':
          aVal = a.model?.name || '';
          bVal = b.model?.name || '';
          break;
        case 'inputTokens':
          aVal = a.tokenUsage?.inputTokens || 0;
          bVal = b.tokenUsage?.inputTokens || 0;
          break;
        case 'outputTokens':
          aVal = a.tokenUsage?.outputTokens || 0;
          bVal = b.tokenUsage?.outputTokens || 0;
          break;
        case 'creditsUsed':
          aVal = a.tokenUsage?.creditsUsed || 0;
          bVal = b.tokenUsage?.creditsUsed || 0;
          break;
        case 'responseTime':
          aVal = a.performance?.totalResponseTime || 0;
          bVal = b.performance?.totalResponseTime || 0;
          break;
        case 'contextTime':
          aVal = a.performance?.contextRetrievalTime || 0;
          bVal = b.performance?.contextRetrievalTime || 0;
          break;
        case 'status':
          aVal = a.status;
          bVal = b.status;
          break;
        default:
          return 0;
      }

      if (sortDirection === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    return filtered;
  }, [metrics, dateFrom, dateTo, userFilter, modelFilter, statusFilter, sortField, sortDirection]);

  // Helper functions
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const clearFilters = () => {
    setDateFrom('');
    setDateTo('');
    setUserFilter('');
    setModelFilter('');
    setStatusFilter('');
  };

  const setDateRange = (days: number) => {
    const today = dayjs();
    const startDate = today.subtract(days, 'day');
    setDateFrom(startDate.toISOString());
    setDateTo(today.toISOString());
  };

  return {
    // Filter states
    dateFrom,
    dateTo,
    userFilter,
    modelFilter,
    statusFilter,
    setDateFrom,
    setDateTo,
    setUserFilter,
    setModelFilter,
    setStatusFilter,

    // UI states
    simplifiedNames,
    setSimplifiedNames,
    activeTab,
    setActiveTab,
    showInfoModal,
    setShowInfoModal,

    // Sort states
    sortField,
    sortDirection,
    setSortField,
    setSortDirection,

    // Computed data
    filteredAndSortedMetrics,

    // Helper functions
    handleSort,
    clearFilters,
    setDateRange,
  };
};
