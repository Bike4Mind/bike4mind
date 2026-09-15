import { accessibleBy } from '@casl/mongoose';
import { Permission } from '@bike4mind/common';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { Session } from '@bike4mind/database/auth';
import { SessionEvents } from '@server/utils/eventBus';
import { assertSessionOperationalCredits } from '@server/utils/sessionOperationalCreditPreflight';

const handler = baseApi().post(
  asyncHandler<{}, unknown, unknown, { id: string }>(async (req, res) => {
    const sessionId = req.query.id;

    const session = await Session.findOne({
      _id: sessionId,
      ...accessibleBy(req.ability!, Permission.update).ofType(Session),
    });
    if (!session) throw new Error('Cannot update session');

    // Queueing the tag IS the spend, so a refusal is the answer to this request (#1852).
    // Billed to the session owner, who the Tag handler resolves - not necessarily the
    // requester, who may only hold update permission on a shared session.
    await assertSessionOperationalCredits({
      userId: session.userId,
      requesterId: req.user?.id,
      operationCount: 1,
      operation: 'session tagging',
      logger: req.logger,
    });

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
