import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { buildRequestFileScope } from '@server/utils/userFileScope';
import { fabFileRepository } from '@bike4mind/database';
import { FILES_READ_SCOPES } from '@bike4mind/server-utils/files/fileScopes';
import { isCoreTutorialSheetNamespace, isCoreTutorialSheetTag } from '@bike4mind/server-utils/tutorials/sheetTags';

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(
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
    //
    // Known consequence of the two scopes disagreeing by design: a tag on N owned/group files
    // plus M personally-shared ones shows count N under WORKSPACES here, then N+M one click later
    // in the Tags view (which reads the unnarrowed tagCounts). This is the partial-count sibling
    // of the whole-row-disappears case (all N+M files personally shared, so the WORKSPACES row
    // vanishes entirely) - both follow from the same personal-share exclusion.
    const scope = buildRequestFileScope(req, req.user);
    const workspaceScope = { ...scope, excludePersonalShares: true };

    const [tagCounts, workspaceTagCounts, namespaceCounts] = await Promise.all([
      fabFileRepository.countFilesByTagForUser(req.user.id, scope),
      fabFileRepository.countFilesByTagForUser(req.user.id, workspaceScope),
      fabFileRepository.countUniqueFilesByNamespaceForUser(req.user.id, workspaceScope),
    ]);

    // The tutorial sheet's bookkeeping tags are not folders the user made; listed, the File Browser would show
    // them as folders beside the sample file the tutorial asks the user to pick.
    const shown = <T extends { tag: string }>(rows: T[]) => rows.filter(row => !isCoreTutorialSheetTag(row.tag));
    const shownWorkspaceTags = shown(workspaceTagCounts);
    // A namespace the user also tags into keeps its folder; its count then still includes the sheet copies.
    const holdsUserTags = (namespace: string) => shownWorkspaceTags.some(row => row.tag.startsWith(`${namespace}:`));
    return res.json({
      tagCounts: shown(tagCounts),
      workspaceTagCounts: shownWorkspaceTags,
      namespaceCounts: namespaceCounts.filter(
        row => !isCoreTutorialSheetNamespace(row.namespace) || holdsUserTags(row.namespace)
      ),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
