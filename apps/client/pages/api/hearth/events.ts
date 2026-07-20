import { hearthRepository } from '@bike4mind/database';
import { HearthLog } from '@bike4mind/hearth';
import { NotFoundError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { requireUser } from '@server/middlewares/requireUser';
import { sendToClient } from '@server/websocket/utils';
import { toWireHearthEvent } from '@server/utils/hearthWire';
import { NextApiRequest, NextApiResponse } from 'next';
import { Resource } from 'sst';
import { z } from 'zod';

const postRateLimit = rateLimit({ limit: 120, windowMs: 60000 });

const PostEventSchema = z.object({
  channelId: z.string().min(1),
  kind: z
    .enum([
      'message',
      'edit',
      'reaction',
      'artifact',
      'presence',
      'delegation',
      'quest.update',
      'gate.request',
      'gate.resolve',
      'system',
    ])
    .prefault('message'),
  human: z.object({
    text: z.string().min(1).max(16000),
    format: z.enum(['md', 'text']).prefault('md'),
  }),
  machine: z
    .object({
      schema: z.string().min(1).max(200),
      payload: z.unknown(),
    })
    .optional(),
  refs: z
    .object({
      threadRootId: z.string().min(1).optional(),
      replyToId: z.string().min(1).optional(),
      questId: z.string().min(1).optional(),
      externalId: z.string().min(1).optional(),
    })
    .prefault({}),
  /**
   * Optional actor identity override. Defaults to the caller's human actor;
   * agents/devices (e.g. the Claude Code hook) self-identify here. The actor
   * is always owned by the authenticated user - this cannot impersonate
   * another user's actors.
   */
  actor: z
    .object({
      kind: z.enum(['human', 'agent', 'gateway', 'device']).prefault('agent'),
      displayName: z.string().min(1).max(200),
    })
    .optional(),
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

    const actor = body.actor
      ? await hearthRepository.ensureActor(req.user.id, body.actor.kind, body.actor.displayName)
      : await hearthRepository.ensureActor(req.user.id, 'human', req.user.username ?? req.user.email ?? 'user');

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
