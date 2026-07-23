import { hearthRepository } from '@bike4mind/database';
import { HearthLog } from '@bike4mind/hearth';
import { NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { requireUser } from '@server/middlewares/requireUser';
import { toWireHearthEvent, HearthActorParamSchema, resolveRequestActor } from '@server/utils/hearthWire';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const catchupRateLimit = rateLimit({ limit: 120, windowMs: 60000 });

const CatchupSchema = z.object({
  channelId: z.string().min(1),
  /** false = peek without consuming (hearth_watch); default advances the cursor. */
  advance: z.boolean().prefault(true),
  limit: z.number().int().min(1).max(500).optional(),
  /**
   * Tail mode: return only the last N events by event count, ignoring and
   * never touching any cursor (used by rendering surfaces like the SPA view).
   */
  tail: z.number().int().min(1).max(500).optional(),
  actor: HearthActorParamSchema,
});

const hearthLog = new HearthLog(hearthRepository.store);

const handler = baseApi()
  .use(requireFeatureEnabled('EnableHearth'))
  .use(requireUser)
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), catchupRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const body = CatchupSchema.parse(req.body);

    const channel = await hearthRepository.getOwnedChannel(req.user.id, body.channelId);
    if (!channel) throw new NotFoundError('Channel not found');

    if (body.tail !== undefined) {
      const tailEvents = await hearthRepository.tailEvents(body.channelId, body.tail);
      const tailNames = await hearthRepository.actorNamesById(tailEvents.map(e => e.actorId));
      res.json({
        events: tailEvents.map(e => toWireHearthEvent(e, tailNames.get(e.actorId))),
        cursor: channel.nextSeq,
      });
      return;
    }

    const actor = await resolveRequestActor(req.user, body.actor);
    const actorId = actor._id.toString();

    const events = await hearthLog.catchup(actorId, body.channelId, {
      advance: body.advance,
      limit: body.limit,
    });

    const names = await hearthRepository.actorNamesById(events.map(e => e.actorId));
    const cursor = await hearthRepository.store.getCursor(actorId, body.channelId);

    res.json({
      events: events.map(e => toWireHearthEvent(e, names.get(e.actorId))),
      cursor,
    });
  });

export default handler;
