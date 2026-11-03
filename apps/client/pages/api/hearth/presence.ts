import { hearthRepository, MAX_ROSTER_ROWS, PRESENCE_STALE_AFTER_MS } from '@bike4mind/database';
import { ApiKeyScope, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { requireUser } from '@server/middlewares/requireUser';
import { toWireHearthPresence } from '@server/utils/hearthWire';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const GetPresenceSchema = z.object({
  channelId: z.string().min(1),
});

/**
 * Matches the catchup read budget. This was the one hearth route with no limit
 * at all, and it is the most expensive: the roster aggregation sorts on an
 * $addFields key, so no index can serve it and mongod sorts in memory, over a
 * collection that grows one permanent row per session. The panel already
 * refetches at up to 1 Hz on presence traffic.
 */
const presenceRateLimit = rateLimit({ limit: 120, windowMs: 60000 });

/**
 * GET the presence roster for a channel: one row per actor, ordered fresh rows
 * first and needs-you-first within them by the repository. Read-only by
 * construction - it advances no cursor and consumes nothing - so read scope is
 * sufficient and there is no write-scope assertion here.
 */
const handler = baseApi({
  requiredScopes: [ApiKeyScope.HEARTH_READ, ApiKeyScope.HEARTH_WRITE, ApiKeyScope.ADMIN],
})
  .use(requireFeatureEnabled('EnableHearth'))
  .use(requireUser)
  .get<NextApiRequest, NextApiResponse>(presenceRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const { channelId } = GetPresenceSchema.parse(req.query);

    const channel = await hearthRepository.getOwnedChannel(req.user.id, channelId);
    if (!channel) throw new NotFoundError('Channel not found');

    const rows = await hearthRepository.presenceForChannel(req.user.id, channelId);
    const actors = await hearthRepository.actorIdentitiesById(rows.map(r => r.actorId.toString()));

    res.json({
      presence: rows.map(row => toWireHearthPresence(row, actors.get(row.actorId.toString()))),
      staleAfterMs: PRESENCE_STALE_AFTER_MS,
      // Published so a full page reads as "capped" rather than "that is everyone".
      // Rows are ranked before the cap applies, so a truncated roster drops stale
      // rows first and keeps fresh rows ahead of them. Freshness orders rows, it
      // does not exempt them: see presenceForChannel for what the cap sheds once
      // fresh rows alone fill it.
      maxRows: MAX_ROSTER_ROWS,
    });
  });

export default handler;
