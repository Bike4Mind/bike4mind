import { ACCESS_TOKEN_TTL_SECONDS, authTokenGenerator } from '@server/auth/tokenGenerator';
import { buildSessionDevice } from '@server/auth/sessionDevice';
import { isTokenVersionCurrent, authSessionService } from '@bike4mind/services';
import { User, userRepository, authSessionRepository, realtimeConnectionRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { HTTPError, UnauthorizedError } from '@bike4mind/utils';
import { z } from 'zod';
import { logAuthAudit } from '@server/utils/authAudit';
import { assertAccountStateUsable } from '@bike4mind/server-utils/auth/assertAccountStateUsable';
import { refuseBlockedRotatedSession } from '@server/auth/refreshAccountGate';
import { API_KEY_ACCESS_DENIED_MESSAGE, assertApiKeyAccessAllowed } from '@server/utils/apiKeyAccessGate';
import { toApiKeyAuthError } from '@bike4mind/server-utils/auth/apiKeyAuthFailure';
import { OAUTH_DEVICE_CLIENT_IDS } from '@bike4mind/common';

const RefreshRequestSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string(),
  client_id: z.enum(OAUTH_DEVICE_CLIENT_IDS),
});

function oauthRefreshErrorCode(error: HTTPError): string {
  if (error.statusCode >= 500) return 'temporarily_unavailable';
  if (error.statusCode === 429) return 'slow_down';
  if (error.statusCode === 403 && error.message === API_KEY_ACCESS_DENIED_MESSAGE) return 'subscription_required';
  return 'invalid_request';
}

const handler = baseApi({ auth: false })
  .use(
    rateLimit({
      limit: 10,
      windowMs: 60 * 1000,
    })
  )
  .post(async (req, res) => {
    const { refresh_token, client_id } = RefreshRequestSchema.parse(req.body);

    const signAccessToken = (id: string, tokenVersion: number, extra?: Record<string, unknown>) =>
      authTokenGenerator.signAccessToken(id, tokenVersion, extra);

    try {
      // New session-store path: rotate the opaque refresh token against the AuthSession store.
      if (authSessionService.isOpaqueRefreshToken(refresh_token)) {
        // Validate trusted session ownership and access before rotation changes the secret.
        // Refusals and transient lookup errors must leave the caller's refresh token usable.
        try {
          const parsed = authSessionService.parseRefreshToken(refresh_token);
          const session = parsed ? await authSessionRepository.findBySid(parsed.sid) : null;
          const user = session ? await userRepository.findById(session.userId) : null;
          if (!user) throw new UnauthorizedError('Invalid refresh token');
          await assertApiKeyAccessAllowed(user, undefined, req);
        } catch (error) {
          throw toApiKeyAuthError(error);
        }
        const rotated = await authSessionService.rotateSession(refresh_token, {
          db: {
            authSessions: authSessionRepository,
            users: userRepository,
            realtimeConnections: realtimeConnectionRepository,
          },
          signAccessToken,
          audit: event =>
            logAuthAudit(req, {
              userId: event.userId,
              event: event.type,
              metadata: { ...event.metadata, sid: event.sid },
            }),
          logger: req.logger,
        });
        await refuseBlockedRotatedSession(rotated, req.logger);
        return res.json({
          access_token: rotated.accessToken,
          // Omitted when a concurrent sibling already advanced the chain. RFC 6749 s6 makes
          // refresh_token optional in a refresh response precisely for this: absent means "keep
          // the one you have", and the client MUST NOT discard its existing token.
          ...(rotated.status === 'rotated' ? { refresh_token: rotated.refreshToken } : {}),
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
        });
      }

      const payload = authTokenGenerator.verifyRefreshToken(refresh_token);

      if (!payload || !payload.userId) {
        throw new UnauthorizedError('Invalid refresh token');
      }

      // Kill switch: load the user and reject a stale refresh token so a
      // revoked session can't be revived through the refresh endpoint.
      const user = await User.findById(payload.userId);
      if (!user || !isTokenVersionCurrent(payload.tokenVersion, user.tokenVersion)) {
        throw new UnauthorizedError('Invalid refresh token');
      }
      // Refused before a session is minted, so nothing is left to revoke.
      assertAccountStateUsable(user);
      try {
        await assertApiKeyAccessAllowed(user, undefined, req);
      } catch (error) {
        throw toApiKeyAuthError(error);
      }

      // Legacy JWT refresh token: lazily migrate onto a session. impersonatedBy is re-stamped so
      // an impersonated session keeps the marker across refresh (logout.ts's guard depends on it).
      const migrated = await authSessionService.issueSession(
        user.id,
        {
          createdVia: 'legacy-migration',
          clientId: client_id,
          tokenVersion: user.tokenVersion ?? 0,
          impersonatedBy: payload.impersonatedBy,
          device: buildSessionDevice(req),
        },
        { db: { authSessions: authSessionRepository }, signAccessToken, logger: req.logger }
      );

      return res.json({
        access_token: migrated.accessToken,
        refresh_token: migrated.refreshToken,
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
      });
    } catch (error) {
      // A 4xx is a verdict on the caller's credential or plan (e.g. a free account refused with
      // subscription_required), routine traffic that must not page the error alert.
      if (error instanceof HTTPError && error.statusCode < 500) {
        req.logger.warn(`Token refresh refused: ${error.statusCode} ${error.message}`);
      } else {
        req.logger.error('Token refresh error:', error);
      }

      // Let a typed HTTP error keep its own status. The blanket 401 below exists to turn any
      // rotation failure into invalid_grant, but not every failure means "your credential is
      // dead": rotateSession raises 429 when a session's replay allowance is spent, deliberately
      // so that an overrun burst is retryable rather than terminal. Flattening it to 401 hands the
      // CLI an invalid_grant, which it treats as revocation and clears the stored tokens - the
      // exact logout that choosing 429 was meant to avoid.
      if (error instanceof HTTPError && error.statusCode !== 401) {
        return res.status(error.statusCode).json({
          error: oauthRefreshErrorCode(error),
          error_description: error.message,
        });
      }

      return res.status(401).json({
        error: 'invalid_grant',
        error_description: 'Invalid or expired refresh token',
      });
    }
  });

export default handler;
