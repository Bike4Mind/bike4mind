import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';

// Query parameter schema
const querySchema = z.object({
  period: z.enum(['24h', '7d', '30d']).default('24h'),
});

interface TelemetryMetrics {
  period: string;
  startDate: string;
  endDate: string;
  totalCompletions: number;
  withTelemetry: number;
  telemetryRate: number;
  anomalyMetrics: {
    totalAnomalies: number;
    avgAnomalyScore: number;
    severityDistribution: Record<string, number>;
    topAnomalyTypes: Array<{ type: string; count: number }>;
  };
  contextMetrics: {
    avgUtilization: number;
    overflowCount: number;
    avgInputTokens: number;
    avgOutputTokens: number;
  };
  performanceMetrics: {
    avgResponseTimeMs: number;
    p50ResponseTimeMs: number;
    p95ResponseTimeMs: number;
    slowResponseCount: number;
  };
  modelMetrics: {
    modelUsage: Array<{ modelId: string; provider: string; count: number }>;
    fallbackCount: number;
    fallbackRate: number;
  };
  toolMetrics: {
    totalToolCalls: number;
    totalFailures: number;
    failureRate: number;
    topFailingTools: Array<{ toolName: string; failureCount: number }>;
  };
  subagentMetrics: {
    totalDelegations: number;
    totalTimeouts: number;
    timeoutRate: number;
  };
}

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const { period } = querySchema.parse(req.query);

    // Calculate date range based on period
    const endDate = new Date();
    const startDate = new Date();
    switch (period) {
      case '24h':
        startDate.setHours(startDate.getHours() - 24);
        break;
      case '7d':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(startDate.getDate() - 30);
        break;
    }

    // Base query for completions in the period
    const baseQuery = {
      timestamp: { $gte: startDate, $lte: endDate },
      type: 'message',
    };

    // Get total completions count
    const totalCompletions = await Quest.countDocuments(baseQuery);

    // Get telemetry-enabled completions count
    const withTelemetry = await Quest.countDocuments({
      ...baseQuery,
      'promptMeta.contextTelemetry': { $exists: true },
    });

    // Aggregate telemetry metrics
    const aggregationResult = await Quest.aggregate([
      {
        $match: {
          ...baseQuery,
          'promptMeta.contextTelemetry': { $exists: true },
        },
      },
      {
        $group: {
          _id: null,
          // Anomaly metrics
          totalAnomalies: {
            $sum: { $cond: [{ $gt: ['$promptMeta.contextTelemetry.anomalies.anomalyScore', 0] }, 1, 0] },
          },
          avgAnomalyScore: { $avg: '$promptMeta.contextTelemetry.anomalies.anomalyScore' },
          severities: { $push: '$promptMeta.contextTelemetry.anomalies.severity' },
          anomalyTypes: { $push: '$promptMeta.contextTelemetry.anomalies.primaryAnomaly' },
          // Context metrics
          avgUtilization: { $avg: '$promptMeta.contextTelemetry.contextWindow.utilizationPercentage' },
          overflowCount: {
            $sum: { $cond: ['$promptMeta.contextTelemetry.contextWindow.overflowDetected', 1, 0] },
          },
          avgInputTokens: { $avg: '$promptMeta.contextTelemetry.contextWindow.inputTokens' },
          avgOutputTokens: { $avg: '$promptMeta.contextTelemetry.contextWindow.outputTokens' },
          // Performance metrics
          responseTimes: { $push: '$promptMeta.contextTelemetry.performance.totalResponseTimeMs' },
          slowResponseCount: {
            $sum: { $cond: ['$promptMeta.contextTelemetry.anomalies.slowTotalResponse', 1, 0] },
          },
          // Model metrics
          models: {
            $push: {
              modelId: '$promptMeta.contextTelemetry.model.modelId',
              provider: '$promptMeta.contextTelemetry.model.provider',
            },
          },
          fallbackCount: { $sum: { $cond: ['$promptMeta.contextTelemetry.model.fallbackUsed', 1, 0] } },
          // Tool metrics
          tools: { $push: '$promptMeta.contextTelemetry.tools' },
          // Subagent metrics
          subagents: { $push: '$promptMeta.contextTelemetry.subagents' },
        },
      },
    ]);

    const agg = aggregationResult[0] || {
      totalAnomalies: 0,
      avgAnomalyScore: 0,
      severities: [],
      anomalyTypes: [],
      avgUtilization: 0,
      overflowCount: 0,
      avgInputTokens: 0,
      avgOutputTokens: 0,
      responseTimes: [],
      slowResponseCount: 0,
      models: [],
      fallbackCount: 0,
      tools: [],
      subagents: [],
    };

    // Calculate severity distribution
    const severityDistribution = (agg.severities as string[]).reduce(
      (acc, sev) => {
        acc[sev] = (acc[sev] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    // Calculate top anomaly types
    const anomalyTypeCounts = (agg.anomalyTypes as string[]).reduce(
      (acc, type) => {
        if (type && type !== 'none') {
          acc[type] = (acc[type] || 0) + 1;
        }
        return acc;
      },
      {} as Record<string, number>
    );
    const topAnomalyTypes = Object.entries(anomalyTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    // Calculate response time percentiles
    const responseTimes = (agg.responseTimes as number[]).filter(t => t != null).sort((a, b) => a - b);
    const avgResponseTimeMs =
      responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0;
    const p50ResponseTimeMs = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.5)] : 0;
    const p95ResponseTimeMs = responseTimes.length > 0 ? responseTimes[Math.floor(responseTimes.length * 0.95)] : 0;

    // Calculate model usage
    const modelCounts = (agg.models as Array<{ modelId: string; provider: string }>).reduce(
      (acc, m) => {
        if (m?.modelId) {
          const key = `${m.provider}:${m.modelId}`;
          if (!acc[key]) {
            acc[key] = { modelId: m.modelId, provider: m.provider, count: 0 };
          }
          acc[key].count++;
        }
        return acc;
      },
      {} as Record<string, { modelId: string; provider: string; count: number }>
    );
    const modelUsage = Object.values(modelCounts).sort((a, b) => b.count - a.count);

    // Calculate tool metrics
    let totalToolCalls = 0;
    let totalToolFailures = 0;
    const toolFailureCounts: Record<string, number> = {};

    for (const toolsArray of (agg.tools as
      | Array<Array<{ toolName: string; invocationCount: number; failureCount: number }>>
      | undefined) || []) {
      if (!toolsArray) continue;
      for (const tool of toolsArray) {
        totalToolCalls += tool.invocationCount || 0;
        totalToolFailures += tool.failureCount || 0;
        if (tool.failureCount > 0) {
          toolFailureCounts[tool.toolName] = (toolFailureCounts[tool.toolName] || 0) + tool.failureCount;
        }
      }
    }
    const topFailingTools = Object.entries(toolFailureCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([toolName, failureCount]) => ({ toolName, failureCount }));

    // Calculate subagent metrics
    let totalDelegations = 0;
    let totalTimeouts = 0;

    for (const subagentsArray of (agg.subagents as
      | Array<Array<{ delegationCount: number; timeoutCount: number }>>
      | undefined) || []) {
      if (!subagentsArray) continue;
      for (const agent of subagentsArray) {
        totalDelegations += agent.delegationCount || 0;
        totalTimeouts += agent.timeoutCount || 0;
      }
    }

    const metrics: TelemetryMetrics = {
      period,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      totalCompletions,
      withTelemetry,
      telemetryRate: totalCompletions > 0 ? (withTelemetry / totalCompletions) * 100 : 0,
      anomalyMetrics: {
        totalAnomalies: agg.totalAnomalies,
        avgAnomalyScore: Math.round((agg.avgAnomalyScore || 0) * 10) / 10,
        severityDistribution,
        topAnomalyTypes,
      },
      contextMetrics: {
        avgUtilization: Math.round((agg.avgUtilization || 0) * 10) / 10,
        overflowCount: agg.overflowCount,
        avgInputTokens: Math.round(agg.avgInputTokens || 0),
        avgOutputTokens: Math.round(agg.avgOutputTokens || 0),
      },
      performanceMetrics: {
        avgResponseTimeMs: Math.round(avgResponseTimeMs),
        p50ResponseTimeMs: Math.round(p50ResponseTimeMs),
        p95ResponseTimeMs: Math.round(p95ResponseTimeMs),
        slowResponseCount: agg.slowResponseCount,
      },
      modelMetrics: {
        modelUsage,
        fallbackCount: agg.fallbackCount,
        fallbackRate: withTelemetry > 0 ? (agg.fallbackCount / withTelemetry) * 100 : 0,
      },
      toolMetrics: {
        totalToolCalls,
        totalFailures: totalToolFailures,
        failureRate: totalToolCalls > 0 ? (totalToolFailures / totalToolCalls) * 100 : 0,
        topFailingTools,
      },
      subagentMetrics: {
        totalDelegations,
        totalTimeouts,
        timeoutRate: totalDelegations > 0 ? (totalTimeouts / totalDelegations) * 100 : 0,
      },
    };

    res.json(metrics);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
