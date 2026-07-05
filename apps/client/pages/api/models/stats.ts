import { Quest, cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { CacheKeys } from '@server/utils/cacheKeys';
import { baseApi } from '@server/middlewares/baseApi';

export interface ModelStatsResponse {
  /** Map of model name to usage count */
  popularity: Record<string, number>;
  /** Map of model name to average response time in ms */
  avgResponseTime: Record<string, number>;
}

async function fetchModelStats(): Promise<ModelStatsResponse> {
  const results = await Quest.aggregate([
    {
      $match: {
        'promptMeta.model.name': { $exists: true },
      },
    },
    {
      $group: {
        _id: '$promptMeta.model.name',
        count: { $sum: 1 },
        avgResponseTime: { $avg: '$promptMeta.performance.totalResponseTime' },
      },
    },
  ]);

  const popularity: Record<string, number> = {};
  const avgResponseTime: Record<string, number> = {};

  for (const result of results) {
    const modelName = result._id as string;
    if (!modelName) continue;
    popularity[modelName] = result.count;
    if (result.avgResponseTime != null) {
      avgResponseTime[modelName] = Math.round(result.avgResponseTime);
    }
  }

  return { popularity, avgResponseTime };
}

const handler = baseApi().get(async (req, res) => {
  const cacheKey = CacheKeys.modelStats();
  const stats = await cacheService.getCachedData(cacheKey, fetchModelStats, {
    db: { caches: cacheRepository },
    expiry: 12 * 60 * 60 * 1000, // 12 hours
    logger: req.logger,
  });

  return res.json(stats);
});

export default handler;
