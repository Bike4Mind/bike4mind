import { NotFoundError, ForbiddenError } from '@bike4mind/common';
import { userRepository, authSessionRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { clearSessionCookies } from '@server/auth/refreshCookie';
import { logAuthAudit } from '@server/utils/authAudit';

/**
 * "Log out all devices" - the global panic lever. Unlike per-device logout, this bumps the user's
 * tokenVersion (rejecting every outstanding access token on its next request, so all devices stop
 * working immediately) AND revokes every AuthSession (killing their refresh cookies). Includes the
 * device that made this call - the client tears down and redirects to /login afterwards.
 */
const handler = baseApi().post(async (req, res) => {
  // An impersonating admin must never trip this: it would bump the real customer's tokenVersion and
  // force-log-out the customer on every device. Refuse rather than silently no-op so the UI (which
  // already hides the button while impersonating) and any direct caller get a clear signal.
  if (req.user.impersonatedBy) {
    throw new ForbiddenError('Cannot log out all devices while impersonating a user.');
  }
  // API keys authenticate before JWT and carry no browser session; a key must not become an
  // account-wide kill switch for its owner (mirrors the guard in /api/logout).
  if (isApiKeyAuth(req)) {
    throw new ForbiddenError('This action is not available to API-key callers.');
  }

  clearSessionCookies(res);

  try {
    await userService.revokeUserSessions(req.user.id, {
      db: { users: userRepository, authSessions: authSessionRepository },
      logger: req.logger,
    });
  } catch (error) {
    // Rare race: the account was deleted between JWT auth and this bump. Nothing is left to
    // revoke, so let the sign-out still succeed rather than surfacing a confusing 404.
    if (!(error instanceof NotFoundError)) throw error;
  }

  await logAuthAudit(req, { userId: req.user.id, event: 'session_revoked', actorUserId: req.user.id });
  return res.status(200).json({ message: 'Logged out of all devices' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
