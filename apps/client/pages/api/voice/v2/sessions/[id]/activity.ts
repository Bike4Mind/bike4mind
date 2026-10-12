/**
 * POST /api/voice/v2/sessions/{id}/activity - the SPA's connect report and heartbeat for an open
 * voice call. The first one marks the hold connected and each one advances its last activity,
 * which connected-time billing reads (server/voice/settleVoiceHold.ts). Not a published endpoint.
 */
import { sessionRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { Request } from 'express';

// Same scope as the end endpoint, so an API-key caller that starts and ends calls can report them too.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post<
  Request<unknown, unknown, unknown, { id: string }>
>(async (req, res) => {
  const { id } = req.query;
  if (!isValidObjectId(id)) throw new NotFoundError('Session not found');

  // Owner-scoped: only the caller's own call can be marked live.
  const session = await sessionRepository.findByIdAndUserId(id, req.user!.id);
  if (!session) throw new NotFoundError('Session not found');

  await sessionRepository.recordVoiceActivity(session.id, new Date());
  return res.status(204).end();
});

export default handler;
