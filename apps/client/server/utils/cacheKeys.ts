import { type EventMetricsFilters } from '@pages/api/admin/event-metrics';
import { type ModelMetricsFilters } from '@pages/api/admin/model-metrics';
import crypto from 'crypto';

/**
 * Payload version per long-TTL cache key. A cached entry is a projection built by
 * one specific version of the code, but the key is otherwise derived only from the
 * request filters, so without this segment a deploy that changes a projection keeps
 * serving payloads built by the previous version until each entry expires.
 *
 * Only the 12h caches are versioned: 12h outlives a deploy, so those entries cannot
 * be waited out. The short-TTL keys further down (60s to 60min) self-heal well inside
 * one deploy and are deliberately left unversioned, so a release does not throw away
 * caches that were about to refresh anyway.
 *
 * BUMP THE ENTRY when the shape *or the values* of that payload change. Each producer
 * carries a pointer comment back here, and cacheKeys.test.ts pins every key's output, so
 * a change to a builder fails there rather than silently re-pointing live callers.
 */
const PAYLOAD_VERSIONS = {
  modelMetrics: 1,
  spend: 1,
  eventMetrics: 1,
  modelStats: 1,
} as const;

/**
 * Hash a filter set into a stable key segment. Empty and absent values are dropped so
 * they share an entry, and the sorted pairs are JSON-serialized so a value containing
 * the delimiter cannot collide with a different set of filters (e.g. "a|userFilter:b").
 */
const hashFilters = (filters: Record<string, string | undefined>): string => {
  const present = Object.keys(filters)
    .filter(key => Boolean(filters[key]))
    .sort()
    .map(key => [key, filters[key]]);

  return crypto.createHash('sha256').update(JSON.stringify(present)).digest('hex').substring(0, 16);
};

/**
 * Cache key builders for read-through caches. These live in the app layer
 * because some keys are derived from app-level request filter types.
 *
 * The filter fields are spelled out per builder rather than spread wholesale: the
 * handlers pass the rest of `req.query`, and hashing an unrecognised param would
 * split the cache on something the projection never reads.
 */
export const CacheKeys = {
  modelMetrics: (filters: ModelMetricsFilters) =>
    `model-metrics:v${PAYLOAD_VERSIONS.modelMetrics}:${hashFilters({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      userFilter: filters.userFilter,
      modelFilter: filters.modelFilter,
      statusFilter: filters.statusFilter,
    })}`,

  spend: (filters: { dateFrom?: string; dateTo?: string; userFilter?: string; modelFilter?: string }) =>
    `admin-spend:v${PAYLOAD_VERSIONS.spend}:${hashFilters({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      userFilter: filters.userFilter,
      modelFilter: filters.modelFilter,
    })}`,

  eventMetrics: (filters: EventMetricsFilters) =>
    `event-metrics:v${PAYLOAD_VERSIONS.eventMetrics}:${hashFilters({
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      userFilter: filters.userFilter,
      eventFilter: filters.eventFilter,
      eventCategoryFilter: filters.eventCategoryFilter,
    })}`,

  modelStats: () => `model-stats:v${PAYLOAD_VERSIONS.modelStats}`,

  userInvites: (userId: string, limit: number, page: number) => {
    return `userInvites:${userId}:${limit}:${page}`;
  },

  securityBehavioralSummary: (userId: string) => {
    return `security-behavioral-summary-v2:${userId}`;
  },

  securityDashboardAiAssessment: (stage: string, fingerprintHash: string) => {
    return `security-dashboard-ai-assessment:${stage}:${fingerprintHash}`;
  },

  modelList: (userId: string) => `model-list:${userId}`,

  refineText: (text: string, context?: string) => {
    const material = JSON.stringify({ text, context: context ?? '' });
    const hash = crypto.createHash('sha256').update(material).digest('hex').substring(0, 16);
    return `refine-text:${hash}`;
  },
};
