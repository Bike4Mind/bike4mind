// GET /api/auth/<strategy>/callback
//   - Authenticate using any service
// POST /api/auth/apple/callback
//   - Apple's form_post return; bounces to the GET form (see below)

import { AuthStrategy } from '@bike4mind/common';
import { authFailLogRepository } from '@bike4mind/database';
import type { OAuthUser } from '@server/utils/auth/verifyCallback';
import { issueBrowserSession } from '@server/auth/issueSession';
import { blockedSignInErrorCode } from '@server/auth/blockedSignIn';
import { verifyStateToken, BaseStatePayload } from '@bike4mind/server-utils/auth/jwtStateStore';
import { authSuccessRedirectQuery, mfaHandoffFragment } from '@server/auth/authSuccessRedirect';
import { logSignInSuccess, resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { oauthIpRateLimit } from '@server/middlewares/oauthIpRateLimit';
import { rateLimit } from '@server/middlewares/rateLimit';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { Request } from 'express';
import passport from 'passport';
import { z } from 'zod';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { readConsentedAcquisitionTouches } from '@server/analytics/acquisition';
import { emitSignupForSourceProducts } from '@server/analytics/signupEvents';
import { emitSignupFunnelEvents, recordSignupAcquisition } from '@server/analytics/funnel';
import { readVisitId } from '@server/analytics/visitSession';
import { recordSignupNetwork } from '@server/auth/networkMeta';
import { recordSignupLanding } from '@server/auth/signupLanding';
import { refreshSignupRiskScore } from '@server/auth/signupRiskScore';
import { AuthEvents } from '@bike4mind/common';
import { resolveOAuthFailureReason, oauthFailureLoginErrorCode } from '@server/utils/auth/oauthFailureReason';
import { isLocalAppUrl } from '@server/utils/validators';
import { stampOAuthSourceTag } from '@server/utils/auth/oauthSourceTag';
import { APPLE_DISPLAY_NAME_MAX_LENGTH, APPLE_USER_FIELD_MAX_LENGTH } from '@bike4mind/server-utils/auth/appleConfig';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';

import { ACCOUNT_LINK_EMAIL_MISMATCH, ACCOUNT_LINK_VERIFICATION_REQUIRED } from '@server/utils/auth/oauthAccountLink';

function isExpectedOAuthError(error: unknown): boolean {
  if (error === ACCOUNT_LINK_EMAIL_MISMATCH || error === ACCOUNT_LINK_VERIFICATION_REQUIRED) return true;
  if (typeof error !== 'object' || error === null) return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  return (
    (name === 'TokenError' && (code === 'invalid_grant' || code === 'bad_verification_code')) ||
    (name === 'UserInfoError' && message === 'Invalid Credentials')
  );
}

/** The form fields Apple's form_post response may carry; anything else is dropped. */
const APPLE_FORM_POST_FIELDS = ['code', 'state', 'user', 'error', 'error_description'] as const;

/**
 * Apple's first-authorization `user` field also carries the email. Only the name is read from it (the
 * email comes from the verified id_token), so forward just the name and keep the address out of the URL.
 */
function appleUserNameOnly(rawUser: string): string | undefined {
  if (rawUser.length > APPLE_USER_FIELD_MAX_LENGTH) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawUser);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const name: unknown = (parsed as { name?: unknown }).name;
  if (typeof name !== 'object' || name === null) return undefined;
  const { firstName, lastName } = name as { firstName?: unknown; lastName?: unknown };
  return JSON.stringify({
    name: {
      ...(typeof firstName === 'string' ? { firstName: firstName.slice(0, APPLE_DISPLAY_NAME_MAX_LENGTH) } : {}),
      ...(typeof lastName === 'string' ? { lastName: lastName.slice(0, APPLE_DISPLAY_NAME_MAX_LENGTH) } : {}),
    },
  });
}

const handler = baseApi({ auth: false })
  .use(async (req, res, next) => {
    // Validate if the strategy is valid
    if (!req.query.strategy || !z.enum(AuthStrategy).safeParse(req.query.strategy).success) {
      throw new BadRequestError('Invalid auth strategy');
    }

    next();
  })
  .use(checkBlockedIP())
  // Apple answers with a cross-site form POST (response_mode=form_post), which withholds the Lax nonce
  // cookie the state store binds the login to and which passport-oauth2 cannot read from a body. Hand
  // the fields to the same-site GET form with a 303, so everything downstream is the Google/GitHub path.
  // It sits ahead of the rate limits so only the GET hop counts against them.
  .post((req, res) => {
    if (req.query.strategy !== AuthStrategy.Apple) {
      throw new BadRequestError('Invalid auth strategy');
    }
    const body: Record<string, unknown> = typeof req.body === 'object' && req.body !== null ? req.body : {};
    const params = new URLSearchParams();
    for (const field of APPLE_FORM_POST_FIELDS) {
      const value = body[field];
      if (typeof value !== 'string') continue;
      const forwarded = field === 'user' ? appleUserNameOnly(value) : value;
      if (forwarded !== undefined) params.set(field, forwarded);
    }
    // passport-oauth2 treats only `access_denied` as a cancelled consent; Apple names it differently.
    if (params.get('error') === 'user_cancelled_authorize') params.set('error', 'access_denied');
    res.redirect(303, `/api/auth/${AuthStrategy.Apple}/callback?${params.toString()}`);
  })
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000, bucket: 'oauth-callback' }))
  .use(oauthIpRateLimit('oauth-callback'))
  .get(async (req: Request<{}, unknown, unknown, { strategy: AuthStrategy; state: string }>, res, next) => {
    const { strategy } = req.query;

    // Okta state is handled via the JWT-based OktaJwtStateStore in auth.ts; the
    // state is self-contained in the JWT, so no session workaround is needed.

    const ip = getClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';

    // In dev, derive callback URL from the actual request host so the token
    // exchange uses the same URL that was sent to the OAuth provider
    const authenticateOptions: Record<string, unknown> = { session: false };
    if (isLocalAppUrl()) {
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const host = req.headers.host || 'localhost:3000';
      authenticateOptions.callbackURL = `${protocol}://${host}/api/auth/${strategy}/callback`;
    }

    // Wrap passport authenticate callback in try-catch to handle async errors
    passport.authenticate(strategy, authenticateOptions, async (err: string, user: OAuthUser, info: unknown) => {
      try {
        const email = (info as any)?.email || undefined;

        if (err) {
          const logError = isExpectedOAuthError(err) ? console.warn : console.error;
          logError('Passport Authenticate Error:', info, err);
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
          // A whitelisted reason is an expected outcome (invite gate, stale or replayed state), so
          // only an unrecognized failure logs at error, the level the alert channel pages on.
          // passport-oauth2 turns a cancelled consent (`?error=access_denied`) into a code-less fail().
          const reason =
            (req.query as { error?: unknown }).error === 'access_denied'
              ? 'access_denied'
              : resolveOAuthFailureReason((info as { code?: unknown } | undefined)?.code);
          const logFailure = reason === 'internal' ? console.error : console.warn;
          logFailure('Passport Authenticate User Not Found Info:', info);
          // Counted by the OAuthSignupsRefused metric filter in infra/authAbuseAlarms.ts; keep the
          // message in sync with its pattern. Only registration_closed is logged on purpose: the alarm
          // tracks closed-registration waves, while the auto-block runner also counts the other reasons.
          if (reason === 'registration_closed') req.logger?.info('oauth-signup-refused');
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
          return res.redirect(`/login?error=${oauthFailureLoginErrorCode(reason)}`);
        }

        // Ban gate, mirroring saml/callback.ts and okta/callback.ts. Without it a banned
        // user regained a full session just by signing in again through Google/GitHub -
        // verifyJwtPayload does not re-check isBanned, so the token stayed live for its
        // whole lifetime.
        if (user.isBanned) {
          try {
            await authFailLogRepository.create({
              strategy,
              ip,
              userAgent,
              reason: 'user_banned',
              email: user.email ?? undefined,
              headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
              meta: { path: req.url, status: 403 },
            });
          } catch (logErr) {
            console.error('Failed to write AuthFailLog (oauth banned):', logErr);
          }
          return res.redirect('/login?error=account_suspended');
        }
        const blockedCode = blockedSignInErrorCode(user);
        if (blockedCode) {
          return res.redirect(`/login?error=${blockedCode}`);
        }

        // Resume the originally requested path, round-tripped via the signed
        // state JWT (embedded by PassportOAuthStateStore.store). /auth/success
        // applies sanitizeRedirectTo before navigating, so pass it through as an
        // opaque, URL-encoded query value (kept out of the token fragment).
        //
        // The state store already verified this token (CSRF) inside
        // passport.authenticate above; we re-decode here only to read the
        // embedded redirectTo and clientId. The extra HS256 verify is cheap and avoids
        // threading the payload out through passport-oauth2's internals.
        const stateResult =
          typeof req.query.state === 'string'
            ? verifyStateToken<BaseStatePayload & { redirectTo?: string; clientId?: string }>(req.query.state, {
                audience: `${strategy}-oauth-state`,
              })
            : undefined;
        const redirectTo = stateResult?.valid ? stateResult.payload.redirectTo : undefined;

        // A brand-new account (flagged by verifyCallback's User.create branch)
        // also logs REGISTER, matching the OTC signup path (pages/api/otc/verify.ts)
        // - OAuth signups used to be indistinguishable from logins in the event log.
        const isNewUser = Boolean(user.isNewUser);
        // Detected before any signup conversion so synthetic accounts stay out of the ad pixel
        // (fragment below) and the product signup emit, not just the funnel events.
        let isSyntheticSignup = false;
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
          await stampOAuthSourceTag(user.id, stateResult?.valid ? stateResult.payload.clientId : undefined);
          await recordSignupNetwork({ req, userId: user.id, method: strategy });
          await recordSignupLanding({ userId: user.id, redirectTo }, req.logger);
          // After recordSignupNetwork so the datacenter signal sees the stored signup network.
          await refreshSignupRiskScore(user.id, req.logger);
          // Credit the signup to the product the visitor came through, if any, and only with
          // consent - see readConsentedAcquisitionTouches. Before the session is minted, as in
          // OTC: a mint failure after the account exists would otherwise lose the signup for
          // good, since the retry sees isNewUser false.
          //
          // The IdP returns the browser here by a top-level CROSS-SITE GET, so the app's own
          // campaign cookies only arrive because utmCapture.ts writes them SameSite=Lax; under
          // Strict they would be withheld on exactly this request and every OAuth signup would
          // emit nothing. That coupling is easy to undo by accident, so it is asserted in
          // utmCapture.test.ts rather than left to this comment.
          //
          // Awaited, against the `void ... .catch()` form analyticsMiddleware and
          // pages/api/analytics/visit.ts use, and deliberately: those emit a daily or
          // per-session event whose loss an idempotent upsert and the next request absorb,
          // while a signup happens once per account and has no later occurrence to recover it
          // - a Lambda freeze after the redirect would drop it for good. The cost is bounded
          // and narrow: emitProductEvent has its own 2s timeout and per-emit catch, and a
          // signup naming no product resolves here immediately, which is most of them.
          const signupFunnel = await recordSignupAcquisition({ req, user, method: strategy });
          isSyntheticSignup = signupFunnel.isSynthetic;
          const funnelUser = {
            id: user.id,
            acquisition: signupFunnel.acquisition,
            isSynthetic: isSyntheticSignup,
            isInternal: signupFunnel.isInternal,
          };
          await emitSignupFunnelEvents({
            user: funnelUser,
            method: strategy,
            emailVerified: user.emailVerified === true,
            creditsGranted: user.signupCreditsGranted ?? 0,
            // The visit cookie is SameSite=Lax, so it arrives on this top-level GET as the
            // campaign cookies do: the signup joins the visit it came from.
            visitId: readVisitId(req.headers.cookie),
          });
          if (!isSyntheticSignup) {
            await emitSignupForSourceProducts({
              userId: user.id,
              touches: readConsentedAcquisitionTouches(req),
              method: strategy,
              account: signupFunnel,
            });
          }
        }

        const successQuery = authSuccessRedirectQuery(redirectTo);

        // isNewUser/signupMethod ride the redirect fragment: /auth/success reads and
        // clears it exactly once, firing the signup ad conversion for new accounts.
        const conversionFragment =
          isNewUser && !isSyntheticSignup ? `&isNewUser=1&signupMethod=${encodeURIComponent(strategy)}` : '';
        const signupFragment = `${conversionFragment}${isNewUser ? '&firstSignupSession=1' : ''}`;

        // Only a genuine new provider binding (flagged by verifyCallback) is an account-link.
        // Audited before the second-factor gate: verifyCallback has already persisted it.
        if (user.isNewOAuthLink) {
          await logAuthAudit(req, { userId: user.id, event: 'oauth_link', strategy });
        }

        // Consumer social sign-in proves the provider account, not the user's own second
        // factor, so an enrolled factor is always challenged (and enforceMFA enrollment owed).
        const secondFactor = await resolveSecondFactor(req, user, { origin: { strategy, createdVia: 'oauth' } });
        if (secondFactor.kind !== 'satisfied') {
          const handoff = mfaHandoffFragment({
            mfaToken: secondFactor.mfaToken,
            userId: user.id,
            mode: secondFactor.kind === 'challenge' ? 'verify' : 'setup',
            passkeyAvailable: secondFactor.kind === 'challenge' && secondFactor.passkeyAvailable,
          });
          return res.redirect(`/auth/success${successQuery}${handoff}${signupFragment}`);
        }

        const { accessToken } = await issueBrowserSession(req, res, user.id, {
          createdVia: 'oauth',
          tokenVersion: user.tokenVersion ?? 0,
        });
        const tokens = { accessToken };

        try {
          await logEvent({
            userId: user.id,
            type: AuthEvents.LOGIN,
            metadata: { strategy, ip, userAgent },
          });
        } catch (logError) {
          console.error('Failed to log OAuth login:', logError);
        }

        await logSignInSuccess(req, { userId: user.id, strategy, trustedDevice: secondFactor.trustedDevice });

        // Redirect with tokens in URL fragment (not query string): a fragment is never sent to
        // the server, so the access token stays out of access logs, Referer headers and browser
        // history.
        const redirectUrl = `/auth/success${successQuery}#token=${tokens.accessToken}&userId=${user.id}${signupFragment}`;
        return res.redirect(redirectUrl);
      } catch (callbackError) {
        // Catch any unhandled errors in the callback to prevent unhandled promise rejections
        console.error('Unhandled error in passport authenticate callback:', callbackError);
        return res.redirect(`/login?error=${oauthFailureLoginErrorCode('internal')}`);
      }
    })(req, res, next);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
