/**
 * POST /api/voice/v2/sessions/{id}/activity - the SPA's connect report and heartbeat for an open
 * voice call. The first one marks the hold connected and each one advances its last activity,
 * which connected-time billing reads (packages/server-utils/src/voice/settleVoiceHold.ts). Not a published endpoint.
 */
import { sessionRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { isValidObjectId } from '@bike4mind/server-utils/utils/objectId';
import { verifyVoiceSessionToken } from '@server/voice/voiceSessionToken';
import { Request } from 'express';

/** The hold start a beat's token names; null when it names none (any open hold); undefined when it fails to verify. */
function holdFromToken(token: unknown, sessionId: string, userId: string): Date | null | undefined {
  if (typeof token !== 'string' || !token) return null;
  try {
    const ctx = verifyVoiceSessionToken(token);
    if (ctx.sessionId !== sessionId || ctx.userId !== userId) return undefined;
    return ctx.voiceHoldStartedAt ? new Date(ctx.voiceHoldStartedAt) : null;
  } catch {
    return undefined;
  }
}

// Same scope as the end endpoint, so an API-key caller that starts and ends calls can report them too.
const handler = baseApi({ requiredScopes: [ApiKeyScope.AI_GENERATE] }).post<
  Request<unknown, unknown, { sessionToken?: unknown } | undefined, { id: string }>
>(async (req, res) => {
  const { id } = req.query;
  if (!isValidObjectId(id)) throw new NotFoundError('Session not found');

  // Owner-scoped: only the caller's own call can be marked live.
  const session = await sessionRepository.findByIdAndUserId(id, req.user!.id);
  if (!session) throw new NotFoundError('Session not found');

  // The call's own session token scopes the beat to its hold, so a call still running on another
  // device cannot mark a newer hold connected. A beat without one (a tab loaded before the token was
  // sent) still counts against the open hold; a token that fails to verify counts for nothing.
  const holdStartedAt = holdFromToken(req.body?.sessionToken, session.id, req.user!.id);
  if (holdStartedAt !== undefined) {
    await sessionRepository.recordVoiceActivity(session.id, new Date(), holdStartedAt);
  }
  return res.status(204).end();
});

export default handler;
