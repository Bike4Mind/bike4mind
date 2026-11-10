import { ApiKeyScope, OAUTH_SOURCE_TAG_PREFIX, SETTINGS_PAGE_READ, type ModelUserTagCount } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { assertFullAdmin } from '@server/modelAccess/modelAccess';

const MAX_TAGS = 2000;

/** Distinct user tags (lower-cased, as model access matches them) with how many live accounts hold each. */
const handler = adminApi({
  adminPermissions: { GET: SETTINGS_PAGE_READ },
  requiredScopes: [ApiKeyScope.ADMIN],
}).get(async (req, res) => {
  assertFullAdmin(req.user);
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
  ]);
  const tags: ModelUserTagCount[] = rows.map(row => ({ tag: row._id, count: row.count }));
  return res.json({ tags });
});

export default handler;
