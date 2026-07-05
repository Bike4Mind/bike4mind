import { accessibleBy } from '@casl/mongoose';
import { Permission } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Session } from '@bike4mind/database/auth';
import { SessionEvents } from '@server/utils/eventBus';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const sessionId = req.query.id;

    const session = await Session.findOne({
      _id: sessionId,
      ...accessibleBy(req.ability!, Permission.update).ofType(Session),
    });
    if (!session) throw new Error('Cannot update session');

    const requestId = await SessionEvents.Tag.publish({ sessionId: session.id });

    return res.json({ message: 'Tagging job queued', requestId });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
