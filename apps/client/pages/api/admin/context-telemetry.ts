import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { Quest } from '@bike4mind/database';
import { z } from 'zod';
import { ForbiddenError } from '@server/utils/errors';
import { TELEMETRY_SAFE_PROJECTION } from '@server/utils/telemetryProjection';

const querySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  modelId: z.string().optional(),
  provider: z.string().optional(),
  minAnomalyScore: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  anomalyType: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Unauthorized. Admin access required.');
    }

    const params = querySchema.parse(req.query);
    const parsedLimit = parseInt(params.limit || '50', 10);
    const parsedOffset = parseInt(params.offset || '0', 10);
    // Validate parsed numbers to prevent NaN from breaking the query
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(parsedLimit, 1), 200);
    const offset = Number.isNaN(parsedOffset) || parsedOffset < 0 ? 0 : parsedOffset;

    // Build query - only fetch quests with context telemetry
    const query: Record<string, unknown> = {
      'promptMeta.contextTelemetry': { $exists: true },
      'promptMeta.contextTelemetry.anomalies.anomalyScore': { $gt: 0 },
    };

    if (params.startDate || params.endDate) {
      query.timestamp = {};
      if (params.startDate) (query.timestamp as Record<string, Date>).$gte = new Date(params.startDate);
      if (params.endDate) (query.timestamp as Record<string, Date>).$lte = new Date(params.endDate);
    }

    if (params.modelId) {
      query['promptMeta.contextTelemetry.model.modelId'] = params.modelId;
    }

    if (params.provider) {
      query['promptMeta.contextTelemetry.model.provider'] = params.provider;
    }

    if (params.minAnomalyScore) {
      const minScore = parseInt(params.minAnomalyScore, 10);
      // Validate parsed number to prevent NaN from breaking the query
      if (!Number.isNaN(minScore) && minScore > 0 && minScore <= 100) {
        query['promptMeta.contextTelemetry.anomalies.anomalyScore'] = { $gte: minScore };
      }
    }

    if (params.severity) {
      query['promptMeta.contextTelemetry.anomalies.severity'] = params.severity;
    }

    if (params.anomalyType && params.anomalyType !== 'none') {
      query['promptMeta.contextTelemetry.anomalies.primaryAnomaly'] = params.anomalyType;
    }

    const [entries, total] = await Promise.all([
      Quest.find(query).select(TELEMETRY_SAFE_PROJECTION).sort({ timestamp: -1 }).skip(offset).limit(limit).lean(),
      Quest.countDocuments(query),
    ]);

    const telemetryEntries = entries.map(entry => ({
      id: entry._id?.toString() ?? '',
      timestamp: entry.timestamp?.toISOString() ?? '',
      telemetry: entry.promptMeta?.contextTelemetry ?? null,
    }));

    // Reuse the main query filters so stats reflect the filtered dataset, not all telemetry.
    const stats = await Quest.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalEntries: { $sum: 1 },
          // Count entries with actual anomalies (primaryAnomaly != 'none')
          totalAnomalies: {
            $sum: {
              $cond: [{ $ne: ['$promptMeta.contextTelemetry.anomalies.primaryAnomaly', 'none'] }, 1, 0],
            },
          },
          avgAnomalyScore: { $avg: '$promptMeta.contextTelemetry.anomalies.anomalyScore' },
          avgUtilization: { $avg: '$promptMeta.contextTelemetry.contextWindow.utilizationPercentage' },
          avgResponseTime: { $avg: '$promptMeta.contextTelemetry.performance.totalResponseTimeMs' },
          providers: { $addToSet: '$promptMeta.contextTelemetry.model.provider' },
          models: { $addToSet: '$promptMeta.contextTelemetry.model.modelId' },
          // Only push non-null severity values
          severityCounts: {
            $push: {
              $cond: [
                { $ne: ['$promptMeta.contextTelemetry.anomalies.severity', null] },
                '$promptMeta.contextTelemetry.anomalies.severity',
                '$$REMOVE',
              ],
            },
          },
        },
      },
    ]);

    const aggregatedStats = stats[0] || {
      totalEntries: 0,
      totalAnomalies: 0,
      avgAnomalyScore: 0,
      avgUtilization: 0,
      avgResponseTime: 0,
      providers: [],
      models: [],
      severityCounts: [],
    };

    const severityDistribution = (aggregatedStats.severityCounts as string[]).reduce(
      (acc: Record<string, number>, severity: string) => {
        acc[severity] = (acc[severity] || 0) + 1;
        return acc;
      },
      {}
    );

    res.json({
      entries: telemetryEntries,
      total,
      offset,
      limit,
      stats: {
        totalEntries: aggregatedStats.totalEntries,
        totalAnomalies: aggregatedStats.totalAnomalies,
        avgAnomalyScore: Math.round((aggregatedStats.avgAnomalyScore || 0) * 10) / 10,
        avgUtilization: Math.round((aggregatedStats.avgUtilization || 0) * 10) / 10,
        avgResponseTimeMs: Math.round(aggregatedStats.avgResponseTime || 0),
        providers: aggregatedStats.providers.filter(Boolean),
        models: aggregatedStats.models.filter(Boolean),
        severityDistribution,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
