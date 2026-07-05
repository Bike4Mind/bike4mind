import { Quest, cacheRepository } from '@bike4mind/database';
import { IChatHistoryItemDocument } from '@bike4mind/common';
import { cacheService } from '@bike4mind/services';
import { CacheKeys } from '@server/utils/cacheKeys';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { Request } from 'express';
import { z } from 'zod';

export const ModelMetricFiltersSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  userFilter: z.string().optional(),
  modelFilter: z.string().optional(),
  statusFilter: z.string().optional(),
});

export const ModelMetricQuerySchema = ModelMetricFiltersSchema.extend({
  recache: z.coerce.boolean().optional(),
});

export type ModelMetricsFilters = z.infer<typeof ModelMetricFiltersSchema>;
export type ModelMetricsQuery = z.infer<typeof ModelMetricQuerySchema>;

interface ModelMetricResponse {
  id: string;
  timestamp: string;
  model: {
    name: string;
    type?: string;
    backend?: string;
    parameters?: {
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    };
  };
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    estimatedCost?: number;
    creditsUsed?: number;
  };
  performance: {
    totalResponseTime?: number;
    contextRetrievalTime?: number;
    modelInferenceTime?: number;
    firstTokenTime?: number;
    clientFirstTokenTime?: number;
    processPickupTime?: number;
    streamingPerformance?: {
      chunkCount?: number;
      totalStreamTime?: number;
      charsPerSecond?: number;
    };
    featureExecutionTimes?: Record<string, number>;
    databaseOperationTimes?: Record<string, number>;
  };
  session: {
    userId?: string;
    organizationId?: string;
    projectId?: string;
  };
  status: string;
  /** Per-stage request lifecycle log, for the status-log timeline. */
  statusLog?: Array<{ status: string; timestamp: string }>;
}

function getProcessPickupTime(quest: IChatHistoryItemDocument): number | undefined {
  const processingTimeLog = (quest.promptMeta?.statusLog || []).find(
    log => log.status === 'Processing your request...'
  );
  if (!processingTimeLog) {
    return;
  }

  return new Date(processingTimeLog.timestamp).getTime() - quest.createdAt.getTime();
}

async function fetchModelMetrics(filters: ModelMetricsFilters): Promise<ModelMetricResponse[]> {
  const { dateFrom, dateTo, userFilter, modelFilter, statusFilter } = filters;

  // Build query with filters
  const query: any = {
    promptMeta: { $exists: true },
    'promptMeta.model.name': { $exists: true },
  };

  // Add date range filter
  if (dateFrom || dateTo) {
    query.timestamp = {};
    if (dateFrom) {
      query.timestamp.$gte = new Date(dateFrom as string);
    }
    if (dateTo) {
      query.timestamp.$lte = new Date(dateTo as string);
    }
  }

  // Add user filter
  if (userFilter && userFilter !== '') {
    query['promptMeta.session.userId'] = userFilter;
  }

  // Add model filter
  if (modelFilter && modelFilter !== '') {
    query['promptMeta.model.name'] = modelFilter;
  }

  // Add status filter
  if (statusFilter && statusFilter !== '') {
    query.status = statusFilter;
  }

  console.log('📊 Query filters:', { dateFrom, dateTo, userFilter, modelFilter, statusFilter });

  // Query quests with filters, sorted by most recent first
  const quests = await Quest.find(query)
    .sort({ timestamp: -1 })
    .limit(500) // Increased limit to handle filtered results
    .lean();

  console.log(`Found ${quests.length} quests with performance data`);

  // Transform the data into the format expected by the frontend
  const metrics: ModelMetricResponse[] = quests.map(quest => ({
    id: quest._id.toString(),
    timestamp: quest.timestamp?.toISOString() || new Date().toISOString(),
    model: {
      name: quest.promptMeta?.model?.name || 'Unknown',
      type: quest.promptMeta?.model?.type || (quest.images || []).length ? 'image' : 'text',
      backend: quest.promptMeta?.model?.backend,
      parameters: {
        temperature: quest.promptMeta?.model?.parameters?.temperature,
        topP: quest.promptMeta?.model?.parameters?.topP,
        maxTokens: quest.promptMeta?.model?.parameters?.maxTokens,
      },
    },
    tokenUsage: {
      inputTokens: quest.promptMeta?.tokenUsage?.inputTokens,
      outputTokens: quest.promptMeta?.tokenUsage?.outputTokens,
      totalTokens: quest.promptMeta?.tokenUsage?.totalTokens,
      estimatedCost: quest.promptMeta?.tokenUsage?.estimatedCost,
      creditsUsed: quest.promptMeta?.tokenUsage?.creditsUsed || quest.creditsUsed,
    },
    performance: {
      totalResponseTime: quest.promptMeta?.performance?.totalResponseTime,
      contextRetrievalTime: quest.promptMeta?.performance?.contextRetrievalTime,
      modelInferenceTime: quest.promptMeta?.performance?.modelInferenceTime,
      firstTokenTime: quest.promptMeta?.performance?.firstTokenTime,
      processPickupTime: getProcessPickupTime(quest),
      streamingPerformance: quest.promptMeta?.performance?.streamingPerformance
        ? {
            chunkCount: quest.promptMeta.performance.streamingPerformance?.chunkCount,
            totalStreamTime: quest.promptMeta.performance.streamingPerformance?.totalStreamTime,
            charsPerSecond: quest.promptMeta.performance.streamingPerformance?.charsPerSecond,
          }
        : undefined,
      featureExecutionTimes: (() => {
        const times = quest.promptMeta?.performance?.featureExecutionTimes;
        if (!times) return undefined;
        try {
          // Handle MongoDB Map serialization formats
          if (times instanceof Map) {
            return Object.fromEntries(times);
          }
          // Handle Mongoose Map serialization (has toObject method)
          if (
            times &&
            typeof times === 'object' &&
            'toObject' in times &&
            typeof (times as any).toObject === 'function'
          ) {
            return (times as any).toObject();
          }
          // Handle plain object or already converted
          if (typeof times === 'object' && times.constructor === Object) {
            return times;
          }
          return undefined;
        } catch (e) {
          console.warn('Failed to convert featureExecutionTimes:', e);
          return undefined;
        }
      })(),
      databaseOperationTimes: (() => {
        const times = quest.promptMeta?.performance?.databaseOperationTimes;
        if (!times) return undefined;
        try {
          // Handle MongoDB Map serialization formats
          if (times instanceof Map) {
            return Object.fromEntries(times);
          }
          // Handle Mongoose Map serialization (has toObject method)
          if (
            times &&
            typeof times === 'object' &&
            'toObject' in times &&
            typeof (times as any).toObject === 'function'
          ) {
            return (times as any).toObject();
          }
          // Handle plain object or already converted
          if (typeof times === 'object' && times.constructor === Object) {
            return times;
          }
          return undefined;
        } catch (e) {
          console.warn('Failed to convert databaseOperationTimes:', e);
          return undefined;
        }
      })(),
    },
    session: {
      userId: quest.promptMeta?.session?.userId,
      organizationId: quest.promptMeta?.session?.organizationId,
      projectId: quest.promptMeta?.session?.projectId,
    },
    status: quest.status || 'unknown',
    statusLog: (quest.promptMeta?.statusLog || []).map(log => ({
      status: log.status,
      timestamp: new Date(log.timestamp).toISOString(),
    })),
  }));

  return metrics;
}

const handler = baseApi().get(async (req: Request<{}, {}, {}, ModelMetricsQuery>, res) => {
  // Check if user has admin permissions
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  console.log('📊 Model metrics API called');

  try {
    const { recache, ...filters } = req.query;

    const cacheKey = CacheKeys.modelMetrics(filters);
    const metrics = await cacheService.getCachedData(cacheKey, () => fetchModelMetrics(filters), {
      db: { caches: cacheRepository },
      expiry: 12 * 60 * 60 * 1000, // 12 hours
      recache,
      logger: req.logger,
    });

    console.log(`✅ Returning ${metrics.length} performance metrics`);
    return res.json(metrics);
  } catch (error) {
    console.error('❌ Error fetching model metrics:', error);
    return res.status(500).json({
      error: 'Failed to fetch model metrics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default handler;
