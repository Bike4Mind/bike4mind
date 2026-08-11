import {
  ForbiddenError,
  IActiveSessionDto,
  IAuthSessionDocument,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { logAuthAudit } from '@server/utils/authAudit';

/** Project an AuthSession row to the client-safe DTO. Never exposes the refresh-token hash. */
function toDto(session: IAuthSessionDocument, currentSid: string | undefined): IActiveSessionDto {
  return {
    sid: session.sid,
    createdVia: session.createdVia,
    device: session.device,
    lastUsedAt: new Date(session.lastUsedAt).toISOString(),
    createdAt: new Date(session.createdAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    impersonated: !!session.impersonatedBy,
    current: session.sid === currentSid,
  };
}

const handler = baseApi()
  // List the caller's own active (non-revoked, non-expired) sessions, newest-active first.
  .get(async (req, res) => {
    // Browser sessions only: an API key must not be able to enumerate its owner's devices - the DTO
    // exposes device.ip / device.location, which were never a key capability. Mirrors the guard in
    // logout.ts / revoke-others.ts (a default baseApi() lets any valid key through as req.user).
    if (isApiKeyAuth(req)) {
      throw new ForbiddenError('This action is not available to API-key callers.');
    }
    const sessions = await authSessionService.listUserSessions(req.user.id, {
      db: { authSessions: authSessionRepository },
    });
    const items = sessions.map(session => toDto(session, req.user.sid));
    return res.status(200).json({ items });
  })
  // Revoke ONE of the caller's sessions ("sign out this device") by `?sid=`. Per-device: clears
  // that session's refresh token so it cannot rotate; its access token lapses within its short TTL.
  // No tokenVersion bump - other sessions are untouched. Ownership is enforced so a user can only
  // revoke their own sessions; an unknown or foreign sid returns 404 (no existence oracle).
  .delete(async (req, res) => {
    // Browser sessions only: without this, any API key becomes a per-session kill switch for its
    // owner - GET hands out the sids this DELETE consumes. Mirrors the GET guard above.
    if (isApiKeyAuth(req)) {
      throw new ForbiddenError('This action is not available to API-key callers.');
    }

    const sid = typeof req.query.sid === 'string' ? req.query.sid : undefined;
    if (!sid) throw new UnprocessableEntityError('sid is required');

    // The current session is not revocable here (the list UI hides its Sign out button). Revoking it
    // would drop the refresh cookie with no client teardown, so the caller keeps working until the
    // access token lapses and is then bounced with no explanation - route self-revoke to /api/logout.
    if (sid === req.user.sid) {
      throw new UnprocessableEntityError('Use POST /api/logout to sign out the current device.');
    }

    const session = await authSessionRepository.findBySid(sid);
    if (!session || session.userId !== req.user.id) {
      throw new NotFoundError('Session not found');
    }

    await authSessionService.revokeSession(sid, {
      db: { authSessions: authSessionRepository },
      logger: req.logger,
    });
    await logAuthAudit(req, { userId: req.user.id, event: 'session_revoked', actorUserId: req.user.id });
    return res.status(200).json({ message: 'Session revoked', sid });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
