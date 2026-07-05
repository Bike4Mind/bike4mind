import { type ModelMetricsFilters } from '@pages/api/admin/model-metrics';
import crypto from 'crypto';

/**
 * Cache key builders for read-through caches. These live in the app layer
 * because some keys are derived from app-level request filter types.
 */
export const CacheKeys = {
  modelMetrics: (filters: ModelMetricsFilters) => {
    const normalizedFilters: Record<string, string> = {};

    if (filters.dateFrom && filters.dateFrom !== '') {
      normalizedFilters.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo && filters.dateTo !== '') {
      normalizedFilters.dateTo = filters.dateTo;
    }

    if (filters.userFilter && filters.userFilter !== '') {
      normalizedFilters.userFilter = filters.userFilter;
    }

    if (filters.modelFilter && filters.modelFilter !== '') {
      normalizedFilters.modelFilter = filters.modelFilter;
    }

    if (filters.statusFilter && filters.statusFilter !== '') {
      normalizedFilters.statusFilter = filters.statusFilter;
    }

    const sortedKeys = Object.keys(normalizedFilters).sort();
    const filterString = sortedKeys.map(key => `${key}:${normalizedFilters[key]}`).join('|');

    const hash = crypto.createHash('sha256').update(filterString).digest('hex').substring(0, 16);

    return `model-metrics:${hash}`;
  },

  userInvites: (userId: string, limit: number, page: number) => {
    return `userInvites:${userId}:${limit}:${page}`;
  },

  eventMetrics: (filters: any) => {
    const normalizedFilters: Record<string, string> = {};

    if (filters.dateFrom && filters.dateFrom !== '') {
      normalizedFilters.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo && filters.dateTo !== '') {
      normalizedFilters.dateTo = filters.dateTo;
    }

    if (filters.userFilter && filters.userFilter !== '') {
      normalizedFilters.userFilter = filters.userFilter;
    }

    if (filters.eventFilter && filters.eventFilter !== '') {
      normalizedFilters.eventFilter = filters.eventFilter;
    }

    if (filters.eventCategoryFilter && filters.eventCategoryFilter !== '') {
      normalizedFilters.eventCategoryFilter = filters.eventCategoryFilter;
    }

    const sortedKeys = Object.keys(normalizedFilters).sort();
    const filterString = sortedKeys.map(key => `${key}:${normalizedFilters[key]}`).join('|');

    const hash = crypto.createHash('sha256').update(filterString).digest('hex').substring(0, 16);

    return `event-metrics:${hash}`;
  },

  securityBehavioralSummary: (userId: string) => {
    return `security-behavioral-summary:${userId}`;
  },

  securityDashboardAiAssessment: (stage: string, fingerprintHash: string) => {
    return `security-dashboard-ai-assessment:${stage}:${fingerprintHash}`;
  },

  modelStats: () => 'model-stats',

  modelList: (userId: string) => `model-list:${userId}`,
};
