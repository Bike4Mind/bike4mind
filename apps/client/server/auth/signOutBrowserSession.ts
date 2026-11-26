import type { Request, Response } from 'express';
import { AuthEvents, type OAuthDeviceClientId } from '@bike4mind/common';
import { userRepository, authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { userService, authSessionService } from '@bike4mind/services';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { clearSessionCookies } from '@bike4mind/server-utils/auth/refreshCookie';
import { logAuthAudit } from '@server/utils/authAudit';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';

const DESKTOP_OAUTH_CLIENT_ID: OAuthDeviceClientId = 'b4m-desktop';

/**
 * Ends the requesting browser's session for `req.user`. Shared by GET /api/logout and
 * POST /api/oauth/end-session (RP-Initiated Logout), so the two sign-out paths cannot drift.
 * `clientId` names the relying party that asked for the sign-out, recorded on the audit row.
 */
export async function signOutBrowserSession(req: Request, res: Response, opts: { clientId?: string } = {}) {
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
  // bump tokenVersion, which rejected every token the user held and signed them out on ALL devices.
  // Revoking just this `sid` leaves other devices signed in; "Log out of all other devices"
  // (POST /api/users/me/sessions/revoke-others) revokes the rest while keeping the current one, and
  // the tokenVersion "sign out everywhere" lever stays on the admin force-logout path. The revoked
  // session's own access token keeps working until its short TTL, but its refresh cookie is dead,
  // so it cannot outlive that window.
  //
  // Skip for API-key callers: apiKeyAuth authenticates before JWT and carries no browser `sid`, so
  // there is nothing to revoke (and the old all-device bump would have made any key an account-wide
  // kill switch). An impersonating admin's `sid` IS this impersonation session, so revoking it is
  // correct and - unlike the old tokenVersion bump - does not touch the real customer's other devices.
  if (sid && !isApiKeyAuth(req)) {
    const revokeDeps = {
      db: { authSessions: authSessionRepository, realtimeConnections: realtimeConnectionRepository },
      logger: req.logger,
    };
    const revoked = await authSessionService.revokeSession(sid, revokeDeps);
    // A Desktop sign-out also ends the web sessions that Desktop opened for itself
    // (pages/api/auth/desktop-web-session/redeem.ts); they carry no link back to the Desktop sid.
    // Best effort: a failed revoke must not skip the remaining ones or the audit row below.
    if (userId && revoked?.clientId === DESKTOP_OAUTH_CLIENT_ID) {
      try {
        const handoffSessions = (await authSessionRepository.findActiveByUserId(userId)).filter(
          session => session.createdVia === 'desktop-handoff'
        );
        const results = await Promise.allSettled(
          handoffSessions.map(session => authSessionService.revokeSession(session.sid, revokeDeps))
        );
        const failed = results.filter(result => result.status === 'rejected').length;
        if (failed > 0) req.logger.warn('[signOut] some Desktop handoff sessions were not revoked', { failed });
      } catch (error) {
        req.logger.warn('[signOut] could not look up Desktop handoff sessions', { error });
      }
    }
  }
  await logEvent({ userId, type: AuthEvents.LOGOUT }, { ability: req.ability });
  if (userId) {
    await logAuthAudit(req, {
      userId,
      event: 'logout',
      ...(opts.clientId ? { metadata: { clientId: opts.clientId } } : {}),
    });
  }
}
