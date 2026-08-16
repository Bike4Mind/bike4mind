import { userRepository, authSessionRepository } from '@bike4mind/database';
import { authSessionService } from '@bike4mind/services';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { UnauthorizedError } from '@server/utils/errors';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import {
  clearAdminReturnCookie,
  readAdminReturnCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '@server/auth/refreshCookie';

/**
 * End an impersonation and restore the admin's own session ("Return to safety").
 *
 * The admin's refresh token was parked in the HttpOnly return cookie by /api/users/[id]/loginAs.
 * Possession of that cookie IS the credential here, so the route is auth: false - the
 * impersonated access token it would otherwise authenticate with belongs to the wrong identity
 * and may already have expired. Rotating the parked token through the session store both proves
 * possession and re-arms reuse detection on the admin session.
 */
const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(rateLimit({ limit: 20, windowMs: 60 * 1000 }))
  .post(async (req, res) => {
    const adminRefreshToken = readAdminReturnCookie(req);
    if (!adminRefreshToken || !authSessionService.isOpaqueRefreshToken(adminRefreshToken)) {
      throw new UnauthorizedError('No admin session to return to');
    }

    // Revoke the impersonation session before restoring the admin. Best-effort: if the
    // impersonated cookie is already gone or its session was revoked, the return must still
    // succeed - stranding an admin inside an impersonation is worse than a lingering row that
    // the session's own expiry will reap.
    const impersonatedToken = readRefreshCookie(req);
    const impersonatedSid = impersonatedToken ? authSessionService.parseRefreshToken(impersonatedToken)?.sid : null;

    const restored = await authSessionService.rotateSession(adminRefreshToken, {
      db: { authSessions: authSessionRepository, users: userRepository },
      signAccessToken: (id, tokenVersion, extra) => authTokenGenerator.signAccessToken(id, tokenVersion, extra),
      logger: req.logger,
    });
    requireNonSystemUser(restored.user);

    if (impersonatedSid) {
      // Only revoke a session this admin actually created by impersonating. The sid is read
      // straight out of a caller-supplied cookie, so without this check a holder of any valid
      // parked return cookie could revoke an arbitrary session by naming its sid.
      const impersonated = await authSessionRepository.findBySid(impersonatedSid).catch(() => null);
      if (impersonated && impersonated.impersonatedBy === restored.userId) {
        await authSessionRepository
          .revokeBySid(impersonatedSid)
          .catch(err => req.logger.error('Failed to revoke impersonation session on return to admin', err));
      }
    }

    // Only ever write cookies when we actually minted a new token. `coalesced` means a concurrent
    // rotation of the parked admin session already advanced the chain - most often a double-clicked
    // "Return to safety", whose winner sets the primary cookie and clears the return slot itself.
    //
    // Both cookie writes are gated together, deliberately. Clearing the return slot on a coalesced
    // response would drop the admin's only durable credential while the primary slot still holds
    // the (now revoked) impersonated token: a 30-minute access token, then a forced re-login. Worse,
    // the revoke above is best-effort - if it failed, the primary slot holds a LIVE impersonated
    // refresh token while this response says `impersonating: false`, so the next refresh would
    // silently reinstate the impersonated identity under a UI that claims otherwise. Leaving both
    // cookies untouched keeps the parked admin token available to retry.
    if (restored.status === 'rotated') {
      setRefreshCookie(res, restored.refreshToken);
      clearAdminReturnCookie(res);
    }

    return res.status(200).json({
      user: redactUserSecretsForSelf(restored.user),
      accessToken: restored.accessToken,
      impersonating: false,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
