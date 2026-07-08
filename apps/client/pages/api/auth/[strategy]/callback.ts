// POST /api/auth/<strategy>/callback
//   - Authenticate using any service

import { AuthStrategy } from '@bike4mind/common';
import { authFailLogRepository, IUserObject } from '@bike4mind/database';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { verifyStateToken, BaseStatePayload } from '@server/auth/jwtStateStore';
import { authSuccessRedirectQuery } from '@server/auth/authSuccessRedirect';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { BadRequestError } from '@server/utils/errors';
import { Request } from 'express';
import passport from 'passport';
import { z } from 'zod';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { AuthEvents } from '@bike4mind/common';
import { resolveOAuthFailureReason, oauthFailureRedirectMessage } from '@server/utils/auth/oauthFailureReason';

const handler = baseApi({ auth: false })
  .use(async (req, res, next) => {
    // Validate if the strategy is valid
    if (!req.query.strategy || !z.enum(AuthStrategy).safeParse(req.query.strategy).success) {
      throw new BadRequestError('Invalid auth strategy');
    }

    next();
  })
  .use(checkBlockedIP())
  .get(async (req: Request<{}, unknown, unknown, { strategy: AuthStrategy; state: string }>, res, next) => {
    const { strategy } = req.query;

    // Okta state is handled via the JWT-based OktaJwtStateStore in auth.ts; the
    // state is self-contained in the JWT, so no session workaround is needed.

    const ip = req.socket?.remoteAddress || (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // In dev, derive callback URL from the actual request host so the token
    // exchange uses the same URL that was sent to the OAuth provider
    const authenticateOptions: Record<string, unknown> = { session: false };
    if (process.env.APP_URL?.includes('localhost')) {
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || 'localhost:3000';
      authenticateOptions.callbackURL = `${protocol}://${host}/api/auth/${strategy}/callback`;
    }

    // Wrap passport authenticate callback in try-catch to handle async errors
    passport.authenticate(strategy, authenticateOptions, async (err: string, user: IUserObject, info: unknown) => {
      try {
        const email = (info as any)?.email || undefined;

        if (err) {
          console.error('Passport Authenticate Error:', info, err);
          try {
            await authFailLogRepository.create({
              strategy,
              ip,
              userAgent,
              reason: typeof err === 'string' ? err : 'OAuth authenticate error',
              email,
              headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
              meta: { path: req.url, status: 500 },
            });
          } catch (logErr) {
            console.error('Failed to write AuthFailLog (oauth err):', logErr);
          }
          const errorMessage = typeof err === 'string' ? err : 'Authentication failed';
          return res.redirect(`/login?error=${encodeURIComponent(errorMessage)}`);
        }
        if (!user) {
          // Raw info (which may embed another user's email or DB error text via
          // info.message) is logged here for CloudWatch only. The audit reason and
          // redirect below must never read anything but the whitelisted code.
          console.error('Passport Authenticate User Not Found Info:', info);
          const reason = resolveOAuthFailureReason((info as { code?: unknown } | undefined)?.code);
          try {
            await authFailLogRepository.create({
              strategy,
              ip,
              userAgent,
              reason,
              email,
              headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
              meta: { path: req.url, status: 500 },
            });
          } catch (logErr) {
            console.error('Failed to write AuthFailLog (oauth no user):', logErr);
          }
          return res.redirect(`/login?error=${encodeURIComponent(oauthFailureRedirectMessage(reason))}`);
        }

        const tokens = authTokenGenerator.createAccessToken(user.id, user.tokenVersion ?? 0);

        try {
          await logEvent({
            userId: user.id,
            type: AuthEvents.LOGIN,
            metadata: { strategy, ip, userAgent },
          });
        } catch (logError) {
          console.error('Failed to log OAuth login:', logError);
        }

        // A brand-new account (flagged by verifyCallback's User.create branch)
        // also logs REGISTER, matching the OTC signup path (pages/api/otc/verify.ts)
        // - OAuth signups used to be indistinguishable from logins in the event log.
        const isNewUser = Boolean((user as { isNewUser?: boolean }).isNewUser);
        if (isNewUser) {
          try {
            await logEvent({
              userId: user.id,
              type: AuthEvents.REGISTER,
              metadata: { strategy },
            });
          } catch (logError) {
            console.error('Failed to log OAuth registration:', logError);
          }
        }

        // Every OAuth callback is a successful authentication; only a genuine
        // new provider binding (flagged by verifyCallback) is an account-link.
        await logAuthAudit(req, { userId: user.id, event: 'login_success', strategy });
        if ((user as { isNewOAuthLink?: boolean }).isNewOAuthLink) {
          await logAuthAudit(req, { userId: user.id, event: 'oauth_link', strategy });
        }

        // Resume the originally requested path, round-tripped via the signed
        // state JWT (embedded by PassportOAuthStateStore.store). /auth/success
        // applies sanitizeRedirectTo before navigating, so pass it through as an
        // opaque, URL-encoded query value (kept out of the token fragment).
        //
        // The state store already verified this token (CSRF) inside
        // passport.authenticate above; we re-decode here only to read the
        // embedded redirectTo. The extra HS256 verify is cheap and avoids
        // threading the payload out through passport-oauth2's internals.
        const stateResult =
          typeof req.query.state === 'string'
            ? verifyStateToken<BaseStatePayload & { redirectTo?: string }>(req.query.state, {
                audience: `${strategy}-oauth-state`,
              })
            : undefined;
        const redirectTo = stateResult?.valid ? stateResult.payload.redirectTo : undefined;
        const successQuery = authSuccessRedirectQuery(redirectTo);

        // Redirect with tokens in URL fragment (not query string)
        // Using fragments prevents tokens from being logged in server access logs,
        // sent in Referer headers, or stored in browser history as query params.
        // isNewUser/signupMethod ride the same fragment: /auth/success reads and
        // clears it exactly once, firing the signup ad conversion for new accounts.
        const signupFragment = isNewUser ? `&isNewUser=1&signupMethod=${encodeURIComponent(strategy)}` : '';
        const redirectUrl = `/auth/success${successQuery}#token=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&userId=${user.id}${signupFragment}`;
        return res.redirect(redirectUrl);
      } catch (callbackError) {
        // Catch any unhandled errors in the callback to prevent unhandled promise rejections
        console.error('Unhandled error in passport authenticate callback:', callbackError);
        return res.redirect('/login?error=Authentication%20failed');
      }
    })(req, res, next);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
