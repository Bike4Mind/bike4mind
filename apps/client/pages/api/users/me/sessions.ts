import { IActiveSessionDto, IAuthSessionDocument, NotFoundError, UnprocessableEntityError } from '@bike4mind/common';
import { authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
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
    const sid = typeof req.query.sid === 'string' ? req.query.sid : undefined;
    if (!sid) throw new UnprocessableEntityError('sid is required');

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
