/**
 * GET /api/v1/quests/{id}/files - the files attached to one quest, with signed download URLs. The
 * public twin of GET /api/quests/[id]/files: same service call and scopes, published through the
 * shared toPublicFile projection. fabFilesService.listFabFilesByQuest answers NotFoundError for a
 * quest that does not exist or whose session the caller cannot see.
 */

import { listQuestFilesContract } from '@bike4mind/common';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { isValidObjectId } from '@server/utils/objectId';
import { NotFoundError } from '@server/utils/errors';
import { toPublicFile } from '@server/files/toPublicFile';
import { listQuestFiles } from '@server/files/listQuestFiles';

const handler = nextRouteForContract(listQuestFilesContract, {
  // Part of the chat-reply poll, like GET /api/v1/quests/{id}: don't let polling burn the daily quota.
  // No perUserRateLimit either, deliberately, matching that route.
  exemptReadsFromDailyRateLimit: true,
}).get(async (req, res) => {
  const { id } = req.validatedParams;
  // A malformed id is a 404, not a CastError from deep in the query (CONVENTIONS.md status table).
  if (!isValidObjectId(id)) throw new NotFoundError('Quest not found');

  const files = await listQuestFiles(req.user.id, id);

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({ files: files.map(toPublicFile) });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
