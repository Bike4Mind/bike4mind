import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { buildUserFileScope } from '@server/utils/userFileScope';
import { fabFileRepository } from '@bike4mind/database';

const handler = baseApi().get(
  asyncHandler<{}, unknown, unknown>(async (req, res) => {
    if (!req.user.id) {
      throw new ForbiddenError('Unauthorized');
    }

    // One scope for both halves of the response: the client keys workspace rows off the tag
    // counts and sizes them from the namespace counts, so a narrower scope on either one shows
    // a shared or data-lake workspace as empty. Also shared with the tag list in ./index.ts.
    const scope = buildUserFileScope(req.user);

    const [tagCounts, namespaceCounts] = await Promise.all([
      fabFileRepository.countFilesByTagForUser(req.user.id, scope),
      fabFileRepository.countUniqueFilesByNamespaceForUser(req.user.id, scope),
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
