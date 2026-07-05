import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { Subscriber } from '@bike4mind/database';

const handler = baseApi().delete(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    if (!req.user?.isAdmin) throw new ForbiddenError('Admin access required');

    const { id } = req.query;
    if (!id) throw new BadRequestError('Invalid ID');

    const subscriber = await Subscriber.findOneAndUpdate(
      { _id: id },
      { $set: { deletedAt: new Date() } },
      { new: true }
    );

    if (!subscriber) throw new BadRequestError('Subscriber not found');

    return res.json(subscriber);
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
