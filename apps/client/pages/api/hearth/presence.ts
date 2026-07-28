import { hearthRepository } from '@bike4mind/database';
import { ApiKeyScope, NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { requireUser } from '@server/middlewares/requireUser';
import { toWireHearthPresence } from '@server/utils/hearthWire';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const GetPresenceSchema = z.object({
  channelId: z.string().min(1),
});

/**
 * Liveness hint, not a filter: the roster returns every row and lets the client
 * decide how to render an actor nobody has heard from lately. The server cannot
 * know the answer - a session idle for ten minutes is dead to a dashboard and
 * perfectly normal to an agent that reports on a heartbeat - so the row keeps
 * its raw lastSeen and this is the shared default for "probably not live".
 */
const PRESENCE_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * GET the presence roster for a channel: one row per actor, ordered
 * needs-you-first by the repository. Read-only by construction - it advances no
 * cursor and consumes nothing - so read scope is sufficient and there is no
 * write-scope assertion here.
 */
const handler = baseApi({
  requiredScopes: [ApiKeyScope.HEARTH_READ, ApiKeyScope.HEARTH_WRITE, ApiKeyScope.ADMIN],
})
  .use(requireFeatureEnabled('EnableHearth'))
  .use(requireUser)
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const { channelId } = GetPresenceSchema.parse(req.query);

    const channel = await hearthRepository.getOwnedChannel(req.user.id, channelId);
    if (!channel) throw new NotFoundError('Channel not found');

    const rows = await hearthRepository.presenceForChannel(req.user.id, channelId);
    const names = await hearthRepository.actorNamesById(rows.map(r => r.actorId.toString()));

    res.json({
      presence: rows.map(row => toWireHearthPresence(row, names.get(row.actorId.toString()))),
      staleAfterMs: PRESENCE_STALE_AFTER_MS,
    });
  });

export default handler;
