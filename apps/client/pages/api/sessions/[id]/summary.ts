import { Permission } from '@bike4mind/common';
import { Session } from '@bike4mind/database/auth';
import { NotFoundError } from '@bike4mind/utils';
import { accessibleBy } from '@casl/mongoose';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';
import { SessionEvents } from '@server/utils/eventBus';
import {
  assertSessionOperationalCredits,
  OPERATIONS_PER_SUMMARIZE_WITH_TAGGING,
} from '@server/utils/sessionOperationalCreditPreflight';

const handler = baseApi().post<Request<{}, unknown, unknown, { id: string }>>(async (req, res) => {
  const sessionId = req.query.id;

  const session = await Session.findOne({
    _id: sessionId,
    ...accessibleBy(req.ability!, Permission.update).ofType(Session),
  });
  if (!session) throw new NotFoundError('Cannot update session');

  // Queueing the summary IS the spend, so a refusal is the answer to this request (#1852).
  // Billed to the session owner, who the Summarize handler resolves - not necessarily the
  // requester, who may only hold update permission on a shared session.
  await assertSessionOperationalCredits({
    userId: session.userId,
    operationCount: OPERATIONS_PER_SUMMARIZE_WITH_TAGGING,
    operation: 'session summarization',
    logger: req.logger,
  });

  const requestId = await SessionEvents.Summarize.publish({
    sessionId: sessionId,
    callTagging: true,
    trigger: 'manual',
  });

  return res.json({ message: 'Summarization job queued', requestId });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
