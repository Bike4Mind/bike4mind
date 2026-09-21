import { Request } from 'express';
import { ForbiddenError } from '@server/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { z } from 'zod';
import { CounterLog, cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { CacheKeys } from '@server/utils/cacheKeys';
import { FilterQuery } from 'mongoose';
import { ICounterLogDocument } from '@bike4mind/common';

// Query schema for filters - used only for type inference via z.infer<typeof ...>
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const EventMetricQuerySchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  userFilter: z.string().optional(),
  eventFilter: z.string().optional(), // Filter by specific event type
  eventCategoryFilter: z.string().optional(), // Filter by event category (Session, File, Curation, etc.)
  recache: z.string().optional(), // Force cache refresh
});

export type EventMetricsQuery = z.infer<typeof EventMetricQuerySchema>;

export interface EventMetricsFilters {
  dateFrom?: string;
  dateTo?: string;
  userFilter?: string;
  eventFilter?: string;
  eventCategoryFilter?: string;
}

interface EventMetricResponse {
  id: string;
  timestamp: string;
  eventName: string;
  eventCategory: string;
  user: {
    userId: string;
    userName: string;
    userLevel: string;
    userOrganization?: string;
    userTags?: string[];
  };
  counterValue: number;
  metadata?: Record<string, any>;
}

// Helper to categorize events
function categorizeEvent(eventName: string): string {
  if (eventName.includes('Session')) return 'Session';
  if (eventName.includes('File') || eventName.includes('Upload') || eventName.includes('Download')) return 'File';
  if (eventName.includes('Curation') || eventName.includes('Curated') || eventName.includes('Notebook Curated'))
    return 'Curation';
  if (eventName.includes('Project')) return 'Project';
  if (eventName.includes('Login') || eventName.includes('Logout') || eventName.includes('Register')) return 'Auth';
  if (eventName.includes('Modal')) return 'Modal';
  if (eventName.includes('Feedback')) return 'Feedback';
  if (eventName.includes('Invite')) return 'Invite';
  if (eventName.includes('Organization')) return 'Organization';
  if (eventName.includes('AI') || eventName.includes('Image')) return 'AI';
  if (eventName.includes('LLM') || eventName.includes('Prompt')) return 'LLM';
  if (eventName.includes('Slack')) return 'Slack';
  return 'Other';
}

// Cached for 12h under a key that carries PAYLOAD_VERSIONS.eventMetrics
// (server/utils/cacheKeys.ts). Change the shape or the values this projects and
// bump that entry, or deployed instances keep serving the old projection.
async function fetchEventMetrics(filters: EventMetricsFilters): Promise<EventMetricResponse[]> {
  const { dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter } = filters;

  // Build query with filters
  const query: FilterQuery<ICounterLogDocument> = {
    counterName: { $exists: true },
  };

  // Add date range filter
  if (dateFrom || dateTo) {
    query.datetime = {};
    if (dateFrom) {
      query.datetime.$gte = new Date(dateFrom);
    }
    if (dateTo) {
      query.datetime.$lte = new Date(dateTo);
    }
  }

  // Add user filter
  if (userFilter && userFilter !== '') {
    query.userId = userFilter;
  }

  // Add event name filter
  if (eventFilter && eventFilter !== '') {
    query.counterName = eventFilter;
  }

  console.log('📊 Event metrics query filters:', { dateFrom, dateTo, userFilter, eventFilter, eventCategoryFilter });

  // Query counter logs with filters, sorted by most recent first
  const counterLogs = await CounterLog.find(query)
    .sort({ datetime: -1 })
    .limit(1000) // Limit for performance
    .lean();

  console.log(`Found ${counterLogs.length} event logs`);

  // Transform the data into the format expected by the frontend
  let metrics: EventMetricResponse[] = counterLogs.map(log => {
    const eventCategory = categorizeEvent(log.counterName);

    return {
      id: log._id?.toString() || '',
      timestamp: log.datetime.toISOString(),
      eventName: log.counterName,
      eventCategory,
      user: {
        userId: log.userId,
        userName: log.userName,
        userLevel: log.userLevel,
        userOrganization: log.userOrganization,
        userTags: log.userTags,
      },
      counterValue: log.counterValue,
      metadata: log.metadata,
    };
  });

  // Apply category filter after transformation (since we categorize dynamically)
  if (eventCategoryFilter && eventCategoryFilter !== '') {
    metrics = metrics.filter(m => m.eventCategory === eventCategoryFilter);
  }

  return metrics;
}

const ONE_MINUTE_MS = 60 * 1000;
// Measured off the two dashboards that call this (app/components/admin/EventMetrics and
// SlackMetrics, both through useEventMetrics): one request per distinct applied filter set behind
// a 60s staleTime, and two per Refresh click - forceRefresh issues the `recache=true` fetch that
// bypasses the 12h cache and then refetches. Neither sets a refetchInterval, and the app's
// QueryClient disables retry and focus/reconnect refetch (app/providers.tsx). An admin tuning
// filters and refreshing on both dashboards at once lands near 20 in a minute, so 30 leaves
// headroom while still bounding the uncached recache path.
const EVENT_METRICS_RATE_LIMIT = 30;

// Chained after baseApi so auth has run and the limiter keys on req.user.id rather than the
// client IP. It also runs ahead of the isAdmin check below, so a non-admin who empties their own
// bucket is refused with 429 instead of 403 - both refuse, and the bucket is per principal.
const handler = baseApi()
  .use(rateLimit({ limit: EVENT_METRICS_RATE_LIMIT, windowMs: ONE_MINUTE_MS, bucket: 'admin-event-metrics' }))
  .get(async (req: Request<{}, {}, {}, EventMetricsQuery>, res) => {
    // Check if user has admin permissions
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    console.log('Event metrics API called');

    try {
      const { recache, ...filters } = req.query;

      const cacheKey = CacheKeys.eventMetrics(filters);
      const metrics = await cacheService.getCachedData(cacheKey, () => fetchEventMetrics(filters), {
        db: { caches: cacheRepository },
        expiry: 1000 * 60 * 60 * 12, // 12 hours (refresh button bypasses this)
        recache: recache === 'true',
        logger: req.logger,
      });

      console.log(`Returning ${metrics.length} event metrics (cached: ${!recache})`);
      return res.json(metrics);
    } catch (error) {
      console.error('Error fetching event metrics:', error);
      return res.status(500).json({
        error: 'Failed to fetch event metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

export default handler;
