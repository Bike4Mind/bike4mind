import { fabFileRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';

/**
 * How many markdown files the legacy Questmaster conversion wrote for the caller. Drives the one-time
 * notice that their v4 plans and v5 graphs were archived (LegacyQuestmasterNotice.tsx).
 */
// Browser-only: no api-contract backs this route, so no API key should reach it.
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const archivedCount = await fabFileRepository.countQuestmasterArchiveFiles(req.user.id);
  return res.json({ archivedCount });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
