// Refuse an invitation
// POST /api/invites/[id]/refuse

import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { sendToClient } from '@server/websocket/utils';
import { sharingService } from '@bike4mind/services';
import { inviteRepository, userRepository } from '@bike4mind/database';
import * as z from 'zod';
import { Resource } from 'sst';

const isPublicSchema = z.object({
  public: z.boolean().optional(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id?: string }>(async (req, res) => {
    const id = req.query.id;
    const params = isPublicSchema.parse(req.body);

    if (!id) {
      return res.status(400).json({ message: 'Invalid refuse invite request' });
    }

    const invite = await sharingService.refuseWholeInvite(
      req.user.id,
      { id, isPublic: !!params.public },
      { db: { invites: inviteRepository, users: userRepository } }
    );

    // trigger refetch on inbox
    const wsEndpoint = Resource.websocket.managementEndpoint;
    await sendToClient(req.user.id, wsEndpoint, {
      action: 'invites_refetch',
      status: 'Refused invite',
    });

    return res.json(invite);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
