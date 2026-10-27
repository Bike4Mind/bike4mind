import { authSessionRepository, realtimeConnectionRepository, userRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { ApiKeyScope, type AdminUserSession, type IAuthSessionDocument } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { parseAdminActionReason, recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { logAuthAudit } from '@server/utils/authAudit';
import { BadRequestError, ensureAdmin, NotFoundError, UnprocessableEntityError } from '@server/utils/errors';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/** Same projection as /api/users/me/sessions; never exposes the refresh-token hash. */
const toAdminSession = (session: IAuthSessionDocument, callerSid: string | undefined): AdminUserSession => ({
  sid: session.sid,
  createdVia: session.createdVia,
  device: session.device,
  lastUsedAt: new Date(session.lastUsedAt).toISOString(),
  createdAt: new Date(session.createdAt).toISOString(),
  expiresAt: new Date(session.expiresAt).toISOString(),
  impersonated: !!session.impersonatedBy,
  current: session.sid === callerSid,
});

const parseUserId = (value: unknown): string => {
  if (typeof value !== 'string' || !OBJECT_ID_PATTERN.test(value)) throw new BadRequestError('Invalid user id');
  return value;
};

/**
 * A user's active sessions, and the per-session revoke. Revoking every session is the existing
 * POST /api/users/[id]/revoke-sessions (tokenVersion bump); this one only clears that session's
 * refresh token, so its access token lapses within its short TTL, as in /api/users/me/sessions.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] })
  .use(csrfProtection())
  .get(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const userId = parseUserId(req.query.userId);
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');

    const sessions = await authSessionService.listUserSessions(user.id, {
      db: { authSessions: authSessionRepository },
    });
    return res.json({ items: sessions.map(session => toAdminSession(session, req.user?.sid)) });
  })
  .delete(async (req, res) => {
    ensureAdmin(req.user?.isAdmin);
    const userId = parseUserId(req.query.userId);
    const sid = typeof req.query.sid === 'string' ? req.query.sid : undefined;
    if (!sid) throw new UnprocessableEntityError('sid is required');
    // Revoking the session that sent this request would strand the admin; /api/logout handles that.
    if (sid === req.user.sid) throw new UnprocessableEntityError('Use sign out to end your own current session.');
    const reason = parseAdminActionReason((req.body as { reason?: unknown } | undefined)?.reason);

    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError('User not found');
    // A sid of another user is a 404, same as an unknown one, so this is no existence oracle. An
    // already-revoked session is a 404 too, so a double submit does not write a second audit row.
    const session = await authSessionRepository.findBySid(sid);
    if (!session || session.userId !== user.id || session.revokedAt) throw new NotFoundError('Session not found');

    await authSessionService.revokeSession(sid, {
      db: { authSessions: authSessionRepository, realtimeConnections: realtimeConnectionRepository },
      logger: req.logger,
    });
    await logAuthAudit(req, { userId: user.id, event: 'session_revoked', actorUserId: req.user.id });
    await recordAdminActionFromRequest(req, {
      action: 'user.session.revoked',
      target: { kind: 'user', id: user.id, displayName: user.name || user.username || user.email || user.id },
      summary: 'signed the user out of one session',
      reason,
      details: { createdVia: session.createdVia, browser: session.device?.browser, os: session.device?.os },
    });
    return res.json({ message: 'Session revoked', sid });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
