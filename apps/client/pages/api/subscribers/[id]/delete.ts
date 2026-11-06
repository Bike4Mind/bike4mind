import { asyncHandler } from '@server/middlewares/asyncHandler';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { Subscriber } from '@bike4mind/database';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({ adminPermissions: { DELETE: 'credits:adjust' } }).delete(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const { id } = req.query;
    if (!id) throw new BadRequestError('Invalid ID');

    const subscriber = await Subscriber.findOneAndUpdate(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );

    if (!subscriber) throw new BadRequestError('Subscriber not found');

    await recordAdminActionFromRequest(req, {
      action: 'user.waitlist_subscriber.deleted',
      target: { kind: 'settings', id: subscriber.id, displayName: subscriber.email },
      summary: `deleted waitlist subscriber ${subscriber.email}`,
    });

    return res.json(subscriber);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
