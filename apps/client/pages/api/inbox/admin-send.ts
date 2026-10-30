import { IUserDocument } from '@bike4mind/common';
import { InboxType } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { User, inboxRepository } from '@bike4mind/database';
import { ForbiddenError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { sendToClient } from '@server/websocket/utils';
import * as z from 'zod';
import { logEvent } from '@server/utils/analyticsLog';
import { InboxEvents } from '@bike4mind/common';
import { Resource } from 'sst';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = baseApi().post(
  asyncHandler(async (req, res) => {
    const user = req.user as IUserDocument;
    const adminId = user?.id;

    if (!user?.isAdmin) {
      throw new ForbiddenError('Only admins can send system messages');
    }

    const wsEndpoint = Resource.websocket.managementEndpoint;

    const validatedBody = z
      .object({
        receiverId: z.string(),
        title: z.string().max(80),
        message: z.string().max(800),
        // LOOP notices are server-written only (loopNotices sweep), never sent through this route.
        type: z.enum([InboxType.COMMON, InboxType.SHARE]).optional().default(InboxType.COMMON),
      })
      .parse(req.body);

    const { receiverId, title, message, type } = validatedBody;
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const receiverUser = await User.findById(receiverId);
    if (!receiverUser?.id) {
      throw new NotFoundError('User not found');
    }

    // Use "SYSTEM" as the sender name
    const systemUserId = 'SYSTEM';

    const newInbox = await inboxRepository.createInboxMessage({
      receiverId: receiverUser.id,
      userId: systemUserId,
      title,
      message,
      type,
    });

    await sendToClient(receiverUser.id, wsEndpoint, {
      action: 'invalidate_query',
      queryKey: ['inboxes'],
    });

    await logEvent(
      {
        userId: adminId,
        type: InboxEvents.CREATE_INBOX,
        metadata: { id: newInbox.id },
      },
      { ability: req.ability }
    );

    await recordAdminActionFromRequest(req, {
      action: 'support.inbox.message_sent',
      target: { kind: 'user', id: receiverUser.id, displayName: receiverUser.username },
      summary: `sent inbox message to ${receiverUser.username}`,
      reason,
      details: { inboxMessageId: newInbox.id, type, titleLength: title.length },
    });

    return res.status(200).json(newInbox);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
