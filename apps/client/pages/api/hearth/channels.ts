import { hearthRepository } from '@bike4mind/database';
import { BadRequestError, UnauthorizedError } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { requireFeatureEnabled } from '@server/middlewares/featureFlag';
import { requireUser } from '@server/middlewares/requireUser';
import { isDuplicateKeyError } from '@server/utils/isDuplicateKeyError';
import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

const createRateLimit = rateLimit({ limit: 10, windowMs: 60000 });

const CreateChannelSchema = z.object({
  name: z.string().min(1).max(200),
});

const handler = baseApi()
  .use(requireFeatureEnabled('EnableHearth'))
  .use(requireUser)
  .get<NextApiRequest, NextApiResponse>(async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const channels = await hearthRepository.listChannelsForUser(req.user.id);
    res.json({
      channels: channels.map(c => ({
        id: c._id.toString(),
        name: c.name,
        gatewayActorId: c.gatewayActorId?.toString(),
        createdAt: c.createdAt.toISOString(),
      })),
    });
  })
  .post<NextApiRequest, NextApiResponse>(csrfProtection(), createRateLimit, async (req, res) => {
    if (!req.user?.id) throw new UnauthorizedError('User required');

    const { name } = CreateChannelSchema.parse(req.body);

    try {
      const channel = await hearthRepository.createChannel(req.user.id, name);
      res.status(201).json({
        channel: {
          id: channel._id.toString(),
          name: channel.name,
          createdAt: channel.createdAt.toISOString(),
        },
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new BadRequestError(`Channel '${name}' already exists`);
      }
      throw err;
    }
  });

export default handler;
