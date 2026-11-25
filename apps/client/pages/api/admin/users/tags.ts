import { OAUTH_SOURCE_TAG_PREFIX, SETTINGS_PAGE_READ, type ModelUserTagCount } from '@bike4mind/common';
import { User, cacheRepository } from '@bike4mind/database';
import { cacheService } from '@bike4mind/services';
import { adminApi } from '@server/middlewares/adminApi';
import { assertFullAdmin } from '@server/modelAccess/modelAccess';
import { CacheKeys } from '@server/utils/cacheKeys';

const MAX_TAGS = 2000;
const QUERY_MAX_TIME_MS = 10_000;
const CACHE_TTL_MS = 60_000;

async function countUserTags(): Promise<ModelUserTagCount[]> {
  const rows = await User.aggregate<{ _id: string; count: number }>([
    { $match: { deletedAt: null, 'tags.0': { $exists: true } } },
    {
      $project: {
        tags: {
          $setUnion: [
            {
              $map: {
                input: { $filter: { input: '$tags', as: 'tag', cond: { $eq: [{ $type: '$$tag' }, 'string'] } } },
                as: 'tag',
                in: { $toLower: { $trim: { input: '$$tag' } } },
              },
            },
            [],
          ],
        },
      },
    },
    { $unwind: '$tags' },
    // source: tags are self-assigned at signup and refused as model access gates.
    { $match: { tags: { $ne: '', $not: new RegExp(`^${OAUTH_SOURCE_TAG_PREFIX}`) } } },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: MAX_TAGS },
  ])
    .option({ maxTimeMS: QUERY_MAX_TIME_MS })
    .read('secondaryPreferred');
  return rows.map(row => ({ tag: row._id, count: row.count }));
}

/** Distinct user tags (lower-cased, as model access matches them) with how many live accounts hold each. */
const handler = adminApi({
  adminPermissions: { GET: SETTINGS_PAGE_READ },
  auth: 'jwtOnly',
}).get(async (req, res) => {
  assertFullAdmin(req.user);
  const tags = await cacheService.getCachedData(CacheKeys.userTags(), countUserTags, {
    db: { caches: cacheRepository },
    expiry: CACHE_TTL_MS,
    logger: req.logger,
  });
  return res.json({ tags });
});

export default handler;
