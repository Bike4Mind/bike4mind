import { IUserDocument } from '@bike4mind/common';
import { InboxType } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User, inboxRepository } from '@bike4mind/database';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { sendToClient } from '@server/websocket/utils';
import * as z from 'zod';
import { logEvent } from '@server/utils/analyticsLog';
import { InboxEvents } from '@bike4mind/common';
import { Resource } from 'sst';

// Creates an inbox message from one user to another
const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const user = req.user as IUserDocument;
    const userId = user?.id;
    const userName = user?.username;
    const userEmail = user?.email;
    const wsEndpoint = Resource.websocket.managementEndpoint;

    const validatedBody = z
      .object({
        receiver: z.string().max(40),
        title: z.string().max(80),
        message: z.string().max(800),
        type: z.nativeEnum(InboxType).optional().default(InboxType.COMMON),
      })
      .parse(req.body);

    const { receiver, title, message, type } = validatedBody;

    if (userName === receiver || userEmail === receiver) {
      throw new BadRequestError('You cannot send a message to yourself');
    }

    let receiverUser = await User.findOne({ username: receiver });

    if (!receiverUser?.id) {
      receiverUser = await User.findOne({ email: receiver });
    }

    // Only throw error if both username and email are not found
    if (!receiverUser?.id) {
      throw new NotFoundError('User not found');
    }

    const newInbox = await inboxRepository.createInboxMessage({
      receiverId: receiverUser?.id,
      userId,
      title,
      message,
      type,
    });

    // trigger refetch on inbox
    await sendToClient(receiverUser.id, wsEndpoint, {
      action: 'invalidate_query',
      queryKey: ['inboxes'],
    });

    await logEvent({ userId, type: InboxEvents.CREATE_INBOX, metadata: { id: newInbox.id } }, { ability: req.ability });

    return res.status(200).json(newInbox);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
