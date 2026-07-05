import { getDataLakeTags } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { fabFileRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.user.id) {
      throw new ForbiddenError('Unauthorized');
    }

    const [tagCounts, namespaceCounts] = await Promise.all([
      fabFileRepository.countFilesByTagForUser(req.user.id, {
        userGroups: req.user.groups ?? [],
        dataLakeTags: getDataLakeTags(req.user.tags ?? []),
      }),
      fabFileRepository.countUniqueFilesByNamespaceForUser(req.user.id),
    ]);

    return res.json({ tagCounts, namespaceCounts });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
