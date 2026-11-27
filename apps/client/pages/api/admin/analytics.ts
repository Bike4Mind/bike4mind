import { adminApi } from '@server/middlewares/adminApi';
import { Quest } from '@bike4mind/database';
import { resolveQuestModelType } from '@server/utils/questModelType';
import { ApiKeyScope, IChatHistoryItemDocument } from '@bike4mind/common';
import { Logger } from '@bike4mind/observability';

const logger = new Logger({ metadata: { service: 'adminAnalytics' } });

interface AnalyticsMetricResponse {
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
    /** Unset when the turn never rendered anything visible. */
    firstTokenTime?: number;
    /** First chunk of any kind, hidden reasoning included. */
    firstChunkTime?: number;
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
}

function getClientFirstTokenTime(quest: IChatHistoryItemDocument): number | undefined {
  return quest.clientFirstTokenTime ?? quest.promptMeta?.performance?.clientFirstTokenTime;
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

function mapQuestToAnalyticsMetric(quest: IChatHistoryItemDocument): AnalyticsMetricResponse {
  return {
    id: quest.id,
    timestamp: quest.timestamp?.toISOString() || new Date().toISOString(),
    model: {
      name: quest.promptMeta?.model?.name || 'Unknown',
      type: resolveQuestModelType(quest),
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
      firstChunkTime: quest.promptMeta?.performance?.firstChunkTime,
      clientFirstTokenTime: getClientFirstTokenTime(quest),
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
          logger.warn('Failed to convert featureExecutionTimes', { error: e });
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
          logger.warn('Failed to convert databaseOperationTimes', { error: e });
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
  };
}

const handler = adminApi({ adminPermissions: { GET: 'support:read' }, requiredScopes: [ApiKeyScope.ADMIN] }).get(
  async (req, res) => {
    try {
      // Extract query parameters (same as model-metrics for consistency)
      const { dateFrom, dateTo, userFilter, modelFilter, statusFilter } = req.query;

      // Build query with filters (same as model-metrics)
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

      // Query quests with filters, sorted by most recent first
      const quests = await Quest.find(query)
        .sort({ timestamp: -1 })
        .limit(1500) // Same limit as model-metrics
        .lean();

      // Transform the data into the format expected by the frontend (same as model-metrics)
      const metrics: AnalyticsMetricResponse[] = quests.map(mapQuestToAnalyticsMetric);

      return res.json(metrics);
    } catch (error) {
      req.logger.error('Error fetching analytics data', { error });
      return res.status(500).json({
        error: 'Failed to fetch analytics data',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
