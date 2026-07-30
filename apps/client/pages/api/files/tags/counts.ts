import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { buildTagCountScope } from '@server/utils/tagCountScope';
import { fabFileRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.user.id) {
      throw new ForbiddenError('Unauthorized');
    }

    const [tagCounts, namespaceCounts] = await Promise.all([
      // Shared with the tag list in ./index.ts; the two must count the same files.
      fabFileRepository.countFilesByTagForUser(req.user.id, buildTagCountScope(req.user)),
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
