import { z } from 'zod';
import { User, inboxRepository } from '@bike4mind/database';
import { sendToClient } from '@server/websocket/utils';
import { IUserDocument } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { logEvent } from '@server/utils/analyticsLog';
import { InboxEvents } from '@bike4mind/common';
import { Resource } from 'sst';

const inboxUpdateSchema = z.object({
  ids: z.array(z.string()).min(1),
});

// Marks one or more inbox messages as read
const handler = baseApi().post(async (req, res) => {
  try {
    const userId = (req.user as IUserDocument)?.id;
    const wsEndpoint = Resource.websocket.managementEndpoint;

    const validatedBody = inboxUpdateSchema.parse(req.body);
    const { ids } = validatedBody;

    const user = await User.findById(userId);

    const receiverIdForRead = user?.isAdmin ? undefined : userId;

    await inboxRepository.markAsRead(ids, receiverIdForRead);

    // trigger refetch inbox for user
    await sendToClient(userId, wsEndpoint, {
      action: 'invalidate_query',
      queryKey: ['inboxes'],
    });

    await logEvent({ userId, type: InboxEvents.READ_INBOX, metadata: { ids } }, { ability: req.ability });

    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(400).json({ message: 'Failed to update inbox', error: err });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
