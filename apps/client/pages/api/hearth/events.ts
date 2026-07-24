import { hearthRepository } from '@bike4mind/database';
import { HearthLog, hearthEventKindSchema, hearthEventRefsSchema, hearthMachineBodySchema } from '@bike4mind/hearth';
import { NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { requireUser } from '@server/middlewares/requireUser';
import { sendToClient } from '@server/websocket/utils';
import { toWireHearthEvent, HearthActorParamSchema, resolveRequestActor } from '@server/utils/hearthWire';
import { NextApiRequest, NextApiResponse } from 'next';
import { Resource } from 'sst';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 120, windowMs: 60000 });

// Enum lists and body shapes come from the @bike4mind/hearth boundary schemas
// (single source of truth); this schema only adds route-level size caps.
const PostEventSchema = z.object({
  channelId: z.string().min(1),
  kind: hearthEventKindSchema.prefault('message'),
  human: z.object({
    text: z.string().min(1).max(16000),
    format: z.enum(['md', 'text']).prefault('md'),
  }),
  machine: hearthMachineBodySchema.extend({ schema: z.string().min(1).max(200) }).optional(),
  refs: hearthEventRefsSchema.prefault({}),
  actor: HearthActorParamSchema,
});

const hearthLog = new HearthLog(hearthRepository.store);

const handler = baseApi()
  .use(requireFeatureEnabled('EnableHearth'))
  .use(requireUser)
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), postRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const body = PostEventSchema.parse(req.body);

    const channel = await hearthRepository.getOwnedChannel(req.user.id, body.channelId);
    if (!channel) throw new NotFoundError('Channel not found');

    const actor = await resolveRequestActor(req.user, body.actor);

    const event = await hearthLog.append({
      channelId: body.channelId,
      actorId: actor._id.toString(),
      kind: body.kind,
      human: body.human,
      machine: body.machine,
      refs: body.refs,
    });

    const wireEvent = toWireHearthEvent(event, actor.displayName);

    // Fanout is best-effort: the event is already durable in the log, and any
    // client that misses the push recovers losslessly via cursor catchup.
    try {
      await sendToClient(req.user.id, Resource.websocket.managementEndpoint, {
        action: 'hearth_event',
        event: wireEvent,
      });
    } catch (err) {
      req.logger?.warn(`hearth_event fanout failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    res.status(201).json({ event: wireEvent });
  });

export default handler;
