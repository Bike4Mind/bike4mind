import { AuthEvents } from '@bike4mind/common';
import { userRepository, authSessionRepository } from '@bike4mind/database';
import { userService, authSessionService } from '@bike4mind/services';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { baseApi } from '@server/middlewares/baseApi';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { clearSessionCookies } from '@server/auth/refreshCookie';

const handler = baseApi().get(async (req, res) => {
  const user = req.user;
  const userId = user?.id;
  const sid = user?.sid;

  // Expire the refresh cookies unconditionally and first: the client can no longer clear them
  // itself (HttpOnly), and a logout that 500s partway must still leave the browser without a
  // usable refresh credential. Includes the impersonation return cookie - an admin who logs out
  // mid-impersonation should not keep a live path back into their own session.
  clearSessionCookies(res);

  await userService.updateLogoutTime(userId, { db: { users: userRepository }, logger: req.logger });

  // Per-device logout: revoke ONLY this browser's session, never bump tokenVersion. Logout used to
  // bump tokenVersion, which rejected every token the user held and signed them out on ALL devices
  // (issue #1194). Revoking just this `sid` leaves other devices signed in; "Log out of all other
  // devices" (POST /api/users/me/sessions/revoke-others) revokes the rest while keeping the current
  // one, and the tokenVersion "sign out everywhere" lever stays on the admin force-logout path. The
  // revoked session's own access token keeps working until its short TTL, but its refresh cookie is
  // dead, so it cannot outlive that window.
  //
  // Skip for API-key callers: apiKeyAuth authenticates before JWT and carries no browser `sid`, so
  // there is nothing to revoke (and the old all-device bump would have made any key an account-wide
  // kill switch). An impersonating admin's `sid` IS this impersonation session, so revoking it is
  // correct and - unlike the old tokenVersion bump - does not touch the real customer's other devices.
  if (sid && !isApiKeyAuth(req)) {
    await authSessionService.revokeSession(sid, {
      db: { authSessions: authSessionRepository },
      logger: req.logger,
    });
  }
  await logEvent({ userId, type: AuthEvents.LOGOUT }, { ability: req.ability });
  if (userId) await logAuthAudit(req, { userId, event: 'logout' });
  return res.status(200).json({ message: 'Logged out' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
