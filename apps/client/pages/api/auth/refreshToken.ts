import { User, userRepository, authSessionRepository } from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { UnauthorizedError } from '@server/utils/errors';
import { isRotatedSecretWithinGraceWindow } from '@server/auth/secretRotationGrace';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { buildSessionDevice } from '@server/auth/sessionDevice';
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
    const token = req.body.token || req.body.refreshToken || req.body.refresh_token;

    if (!token) throw new UnauthorizedError('Refresh token is required');

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
      return res.status(200).json({
        user: rotated.user,
        accessToken: rotated.accessToken,
        refreshToken: rotated.refreshToken,
      });
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

    return res.status(200).json({
      user,
      accessToken: migrated.accessToken,
      refreshToken: migrated.refreshToken,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
