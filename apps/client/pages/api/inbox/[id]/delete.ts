import { IUserDocument } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User, inboxRepository } from '@bike4mind/database';
import { BadRequestError } from '@server/utils/errors';
import { sendToClient } from '@server/websocket/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { InboxEvents } from '@bike4mind/common';
import { Resource } from 'sst';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const userId = (req.user as IUserDocument)?.id;
    const id = req.query.id;

    if (!id) throw new BadRequestError('Invalid ID');

    const [inbox, user] = await Promise.all([inboxRepository.findById(id), User.findById(userId)]);

    if (!inbox || (!user?.isAdmin && inbox.receiverId !== userId)) throw new BadRequestError('Inbox not found');

    // Admins can delete using the inbox item's actual receiverId; otherwise
    // use the current user's id (the receiver) to enforce ownership.
    const receiverIdForDeletion = user?.isAdmin ? inbox.receiverId : userId;
    const deletedInboxItem = await inboxRepository.deleteByReceiverId(receiverIdForDeletion, id);

    const wsEndpoint = Resource.websocket.managementEndpoint;
    // Trigger refetch for the actual receiver of the item, not necessarily the requesting admin
    await sendToClient(receiverIdForDeletion, wsEndpoint, {
      action: 'invalidate_query',
      queryKey: ['inboxes'],
    });
    await logEvent({ userId, type: InboxEvents.DELETE_INBOX, metadata: { id } }, { ability: req.ability });

    return res.status(200).json(deletedInboxItem);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
