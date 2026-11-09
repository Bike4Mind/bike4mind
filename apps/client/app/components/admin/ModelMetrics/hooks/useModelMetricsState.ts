import { useState, useMemo } from 'react';
import dayjs from 'dayjs';
import { ModelMetric, SortField, SortDirection } from '../types';

export type ModelMetricsTabValue = 'overview' | 'analytics' | 'data' | 'spend';

export const useModelMetricsState = (metrics: ModelMetric[]) => {
  // UI states
  const [simplifiedNames, setSimplifiedNames] = useState(true);
  const [activeTab, setActiveTab] = useState<ModelMetricsTabValue>('overview');
  const [showInfoModal, setShowInfoModal] = useState(false);

  // Sort states
  const [sortField, setSortField] = useState<SortField>('timestamp');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');

  // The server already applied the filters; only the order is decided here.
  const filteredAndSortedMetrics = useMemo(() => {
    const filtered = [...metrics];

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
  }, [metrics, sortField, sortDirection]);

  // Helper functions
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  return {
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
  };
};
