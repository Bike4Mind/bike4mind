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

    // This endpoint backs TWO surfaces that must NOT share one scope: the Tags view (tag tree +
    // its click-through to GET /api/files/search, which counts personal shares) needs `tagCounts`
    // unnarrowed, while WORKSPACES (Home/Overview) needs the personal-share exclusion so a tag the
    // caller already cleared their own copy of can't stay orphaned by someone else's share.
    // `workspaceTagCounts`/`namespaceCounts` are the WORKSPACES-only pair and must share the SAME
    // (narrowed) scope with each other, or a workspace row's existence and its size disagree.
    const scope = buildUserFileScope(req.user);
    const workspaceScope = { ...scope, excludePersonalShares: true };

    const [tagCounts, workspaceTagCounts, namespaceCounts] = await Promise.all([
      fabFileRepository.countFilesByTagForUser(req.user.id, scope),
      fabFileRepository.countFilesByTagForUser(req.user.id, workspaceScope),
      fabFileRepository.countUniqueFilesByNamespaceForUser(req.user.id, workspaceScope),
    ]);

    return res.json({ tagCounts, workspaceTagCounts, namespaceCounts });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
