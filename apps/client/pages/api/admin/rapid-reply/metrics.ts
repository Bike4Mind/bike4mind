import { rapidReplyResultRepository } from '@bike4mind/database/ai';
import { rapidReplyMappingRepository } from '@bike4mind/database/ai';
import { rapidReplyPromptRepository } from '@bike4mind/database/ai';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

interface MetricsFilters {
  startDate?: string;
  endDate?: string;
  mainModelId?: string;
  rapidModelId?: string;
  userId?: string;
  timeRange?: 'last24h' | 'last7d' | 'last30d' | 'last90d' | 'custom';
}

const handler = baseApi().get(async (req, res) => {
  if (!req.user?.isAdmin) {
    throw new ForbiddenError('Unauthorized. Admin access required.');
  }

  console.log('📊 Rapid Reply metrics API called');

  const { startDate, endDate, mainModelId, rapidModelId, userId, timeRange = 'last30d' } = req.query as MetricsFilters;

  // Calculate date range based on timeRange parameter
  let calculatedStartDate: Date | undefined;
  let calculatedEndDate: Date | undefined;

  if (timeRange && timeRange !== 'custom') {
    const now = new Date();
    calculatedEndDate = now;

    switch (timeRange) {
      case 'last24h':
        calculatedStartDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case 'last7d':
        calculatedStartDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'last30d':
        calculatedStartDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'last90d':
        calculatedStartDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
    }
  } else if (startDate || endDate) {
    if (startDate) calculatedStartDate = new Date(startDate);
    if (endDate) calculatedEndDate = new Date(endDate);
  }

  // Validate date range
  if (calculatedStartDate && calculatedEndDate && calculatedStartDate > calculatedEndDate) {
    throw new BadRequestError('Start date cannot be after end date');
  }

  const filters = {
    startDate: calculatedStartDate,
    endDate: calculatedEndDate,
    mainModelId: mainModelId as string,
    rapidModelId: rapidModelId as string,
    userId: userId as string,
  };

  // Get main metrics
  const metrics = await rapidReplyResultRepository.getMetrics(filters);

  // Get additional insights
  const [totalMappings, activeMappings, totalPrompts, activePrompts] = await Promise.all([
    rapidReplyMappingRepository.findAll().then(mappings => mappings.length),
    rapidReplyMappingRepository.findEnabled().then(mappings => mappings.length),
    rapidReplyPromptRepository.findAll().then(prompts => prompts.length),
    rapidReplyPromptRepository.findActive().then(prompts => prompts.length),
  ]);

  // Calculate performance metrics
  const performanceMetrics = {
    latencySavingsPercentage:
      metrics.averageLatencySavings > 0
        ? Math.round((metrics.averageLatencySavings / (metrics.averageLatency + metrics.averageLatencySavings)) * 100)
        : 0,

    qualityScore: metrics.averageQualityScore || 0,
    userExperienceScore: metrics.averageUserExperienceScore || 0,

    // Calculate trend (would need historical data for proper implementation)
    successRateTrend: 'stable', // 'improving' | 'declining' | 'stable'
    latencyTrend: 'stable',
    usageTrend: 'stable',
  };

  // Transform model pair stats and sort by lowest latency (default)
  const transformedModelBreakdown = metrics.modelPairStats
    .map(pair => ({
      mainModel: pair.mainModelId,
      rapidModel: pair.rapidModelId,
      usageCount: pair.count,
      avgLatency: Math.round(pair.averageLatency),
      avgTtfvtSavings: pair.averageTtfvtSavings ? Math.round(pair.averageTtfvtSavings) : null,
      avgTtfvt: pair.averageTtfvt ? Math.round(pair.averageTtfvt) : null,
      successRate: Math.round(pair.successRate * 100) / 100,
    }))
    .sort((a, b) => a.avgLatency - b.avgLatency);

  const response = {
    metrics: {
      totalRequests: metrics.totalRequests,
      successRate: Math.round(metrics.successRate * 100) / 100,
      averageLatency: Math.round(metrics.averageLatency),
      averageLatencySavings: Math.round(metrics.averageLatencySavings),
      averageTtfvtSavings: metrics.averageTtfvtSavings ? Math.round(metrics.averageTtfvtSavings) : null,
      averageTtfvt: metrics.averageTtfvt ? Math.round(metrics.averageTtfvt) : null,
    },
    activeMappings,
    modelBreakdown: transformedModelBreakdown,
    performance: performanceMetrics,
    summary: {
      totalMappings,
      totalPrompts,
      activePrompts,
    },
    timeRange: {
      start: calculatedStartDate?.toISOString(),
      end: calculatedEndDate?.toISOString(),
      range: timeRange,
    },
    filters: {
      mainModelId,
      rapidModelId,
      userId,
    },
  };

  console.log(`✅ Returning rapid reply metrics for ${metrics.totalRequests} requests`);
  return res.json(response);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
