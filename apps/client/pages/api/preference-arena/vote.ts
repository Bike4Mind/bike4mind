import { arenaVoteRequestSchema } from '@bike4mind/common';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { parseOrBadRequest } from '@bike4mind/server-utils/utils/errors';
import { baseApi } from '@server/middlewares/baseApi';
import { getArenaService } from '@server/preferenceArena';

const MINUTE_MS = 60 * 1000;

/** POST /api/preference-arena/vote - judge the outstanding pair; answers only with the credits earned. */
const handler = baseApi({ auth: 'jwtOnly' })
  .use(rateLimit({ limit: 60, windowMs: MINUTE_MS, bucket: 'preference-arena-vote' }))
  .post(async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const request = parseOrBadRequest(arenaVoteRequestSchema, req.body);
    return res.status(200).json(await getArenaService(req.logger).submitVote(req.user.id, request));
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
