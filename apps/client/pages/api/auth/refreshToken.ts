import { User, userRepository, authSessionRepository } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { UnauthorizedError } from '@server/utils/errors';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { redactUserSecretsForSelf } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { buildSessionDevice } from '@server/auth/sessionDevice';
import { readRefreshCookie, setRefreshCookie } from '@server/auth/refreshCookie';
import { isTokenVersionCurrent, authSessionService } from '@bike4mind/services';

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  // Per-IP cap: parity with the CLI /api/oauth/refresh and OTC endpoints, which were already
  // guarded. A refresh JWT can't be brute-forced (HS256 signature), so this is abuse/DoS
  // hardening, not credential guessing. The window is per-minute and generous so shared-NAT
  // bursts (many users whose access token expires around the same time) don't trip it; a single
  // client refreshes at most once per cascade (guarded by refreshPromise in ApiContext).
  .use(rateLimit({ limit: 60, windowMs: 60 * 1000 }))
  .post(async (req, res) => {
    // Accept multiple field names: "token" (legacy B4M), "refreshToken" (camelCase), "refresh_token" (OAuth standard)
    const bodyToken = req.body.token || req.body.refreshToken || req.body.refresh_token;
    const cookieToken = readRefreshCookie(req);
    const token = bodyToken || cookieToken;

    if (!token) throw new UnauthorizedError('Refresh token is required');

    // Transport selection. A browser presents the token in the HttpOnly cookie and gets the
    // rotated one back the same way - never in the JSON body, which page scripts can read.
    // Non-browser callers (CLI, OAuth flows) present it in the body and get it back in the body.
    // `cookie: true` is the one-shot migration hook: a browser whose refresh token is still in
    // localStorage from before this change sends it in the body ONCE with this flag, and is
    // moved onto the cookie without being logged out.
    const useCookie = !bodyToken || req.body.cookie === true;
    const respond = (payload: Record<string, unknown>, refreshToken: string) => {
      if (useCookie) {
        setRefreshCookie(res, refreshToken);
        return res.status(200).json(payload);
      }
      return res.status(200).json({ ...payload, refreshToken });
    };

    const signAccessToken = (id: string, tokenVersion: number, extra?: Record<string, unknown>) =>
      authTokenGenerator.signAccessToken(id, tokenVersion, extra);

    // New session-store path: an opaque `<sid>.<secret>` refresh token is rotated against the
    // AuthSession store (rotation + grace window + reuse detection live in the service).
    if (authSessionService.isOpaqueRefreshToken(token)) {
      const rotated = await authSessionService.rotateSession(token, {
        db: { authSessions: authSessionRepository, users: userRepository },
        signAccessToken,
        logger: req.logger,
      });
      requireNonSystemUser(rotated.user);
      return respond(
        {
          // Redact before returning: the bootstrap refresh feeds this straight into the client's
          // currentUser, so it must carry the same self-view shape as the login endpoints.
          user: redactUserSecretsForSelf(rotated.user),
          accessToken: rotated.accessToken,
          impersonating: !!rotated.impersonatedBy,
        },
        rotated.refreshToken
      );
    }

    // Legacy JWT refresh token: verify as before, then lazily migrate the holder onto a session
    // (mint a fresh AuthSession + opaque refresh token) so nobody is logged out on deploy.
    // Support secret rotation: if JWT_SECRET was recently rotated, allow tokens
    // signed with the previous secret for a 24-hour grace period
    const secretRotation = await secretRotationRepository.findByKeyName('JWT_SECRET');
    let previousSecret: string | undefined;
    if (isRotatedSecretWithinGraceWindow(secretRotation?.rotatedAt)) {
      previousSecret = secretRotation?.previousKey;
    }

    const decoded = authTokenGenerator.verifyRefreshToken(token, previousSecret);

    if (!decoded) throw new UnauthorizedError('Invalid refresh token');

    const user = await User.findById(decoded.userId);

    if (!user) throw new UnauthorizedError('Unauthorized');

    requireNonSystemUser(user);

    // Kill switch: a stale refresh token must not be exchangeable for fresh
    // access tokens, otherwise revocation could be bypassed via refresh.
    if (!isTokenVersionCurrent(decoded.tokenVersion, user.tokenVersion)) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Migrate: mint a fresh session. impersonatedBy is re-stamped so an impersonated session that
    // refreshes keeps the marker (otherwise logout.ts's impersonation guard stops applying).
    const migrated = await authSessionService.issueSession(
      user.id,
      {
        createdVia: 'legacy-migration',
        tokenVersion: user.tokenVersion ?? 0,
        impersonatedBy: decoded.impersonatedBy,
        device: buildSessionDevice(req),
      },
      { db: { authSessions: authSessionRepository }, signAccessToken, logger: req.logger }
    );

    return respond(
      {
        user: redactUserSecretsForSelf(user),
        accessToken: migrated.accessToken,
        impersonating: !!decoded.impersonatedBy,
      },
      migrated.refreshToken
    );
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
