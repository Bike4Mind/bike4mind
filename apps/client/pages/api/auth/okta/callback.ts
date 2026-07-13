/**
 * Okta OAuth Callback Handler
 *
 * Handles the OAuth callback from Okta using OpenID Connect with proper PKCE support.
 *
 * Security features:
 * - JWT state token verification
 * - PKCE code verifier extraction and usage in token exchange
 * - IDP ID extraction for database config routing
 * - Proper error logging for auth failures
 *
 * @see https://datatracker.ietf.org/doc/rfc7636/
 */
import { Request, Response } from 'express';
import { authFailLogRepository, User } from '@bike4mind/database';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { IAuthProviders } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getOktaConfigWithFallback, exchangeCodeForTokens, fetchUserInfo } from '@server/auth/oktaOidcClient';
import { verifyStateToken } from '@server/auth/jwtStateStore';
import { authSuccessRedirectQuery } from '@server/auth/authSuccessRedirect';
import { OKTA_STATE_AUDIENCE, OktaStatePayload } from '@server/auth/oktaConstants';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { AuthEvents, AuthStrategy } from '@bike4mind/common';
import { ForbiddenError } from '@server/utils/errors';
import { requireNonSystemUser } from '@server/auth/requireNonSystemUser';
import { validateAppUrl } from '@server/utils/validators';
import { encryptSecret } from '@server/security/secretEncryption';
import { Config } from '@server/utils/config';
import { Logger } from '@bike4mind/observability';
import { decideAutoLink, applyAccountLink } from '@server/utils/auth/oauthAccountLink';

/**
 * Type guard to validate query parameter is a non-empty string.
 * Protects against array injection and ensures type safety.
 * Also rejects whitespace-only strings for robustness.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Sanitize OAuth error codes to user-friendly messages.
 * Prevents leaking internal Okta error details to users.
 */
function sanitizeOAuthError(error: string): string {
  const errorMap: Record<string, string> = {
    access_denied: 'Access was denied',
    invalid_request: 'Authentication request failed',
    invalid_scope: 'Authentication request failed',
    invalid_client: 'Authentication request failed',
    server_error: 'Authentication service unavailable',
    temporarily_unavailable: 'Authentication service temporarily unavailable',
    login_required: 'Login is required',
    consent_required: 'User consent is required',
  };
  return errorMap[error] || 'Authentication failed';
}

const handleOktaCallback = async (req: Request, res: Response) => {
  const ip = req.socket?.remoteAddress || (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  try {
    // Validate query parameters - ensures string type (not arrays) and non-empty
    const state = isNonEmptyString(req.query.state) ? req.query.state : undefined;
    const code = isNonEmptyString(req.query.code) ? req.query.code : undefined;
    const error = isNonEmptyString(req.query.error) ? req.query.error : undefined;
    const errorDescription = isNonEmptyString(req.query.error_description) ? req.query.error_description : undefined;

    // Handle OAuth errors from Okta
    if (error) {
      // Log full error details for debugging, but show sanitized message to user
      Logger.error('[Okta Callback] OAuth error from Okta:', { error, errorDescription });
      await authFailLogRepository.create({
        strategy: 'okta',
        ip,
        userAgent,
        reason: errorDescription || error,
        headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
        meta: { path: req.url, status: 401 },
      });
      // Sanitize error message to prevent information leakage
      const userMessage = sanitizeOAuthError(error);
      return res.redirect(`/login?error=${encodeURIComponent(userMessage)}`);
    }

    if (!state) {
      Logger.error('[Okta Callback] Missing state parameter');
      return res.redirect('/login?error=missing_state');
    }

    if (!code) {
      Logger.error('[Okta Callback] Missing authorization code');
      return res.redirect('/login?error=missing_code');
    }

    // Verify and decode the state token to get IDP ID and PKCE verifier
    const stateResult = verifyStateToken<OktaStatePayload>(state, {
      audience: OKTA_STATE_AUDIENCE,
    });

    if (!stateResult.valid) {
      Logger.error('[Okta Callback] Invalid state token:', stateResult.reason);
      await authFailLogRepository.create({
        strategy: 'okta',
        ip,
        userAgent,
        reason: `Invalid state: ${stateResult.message}`,
        headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
        meta: { path: req.url, status: 401 },
      });
      return res.redirect(`/login?error=${encodeURIComponent(stateResult.message)}`);
    }

    const { idpId, codeVerifier, redirectTo } = stateResult.payload;
    Logger.debug('[Okta Callback] State verified, IDP ID:', idpId || 'sst-fallback');

    if (!codeVerifier) {
      Logger.error('[Okta Callback] Missing code verifier in state');
      return res.redirect('/login?error=invalid_state');
    }

    // Resolve Okta config using the IDP ID from state
    const { config, source, idp } = await getOktaConfigWithFallback(idpId);

    if (!config) {
      Logger.error('[Okta Callback] No Okta configuration available for IDP:', idpId);
      return res.redirect('/login?error=okta_config_missing');
    }

    Logger.debug('[Okta Callback] Config resolved:', { source, idpId: idp?.id || 'sst-fallback' });

    // Validate APP_URL before constructing callback URL
    const appUrl = validateAppUrl('Okta Callback');
    if (!appUrl) {
      Logger.error('[Okta Callback] APP_URL environment variable is missing or invalid');
      return res.redirect('/login?error=server_configuration_error');
    }

    // Build callback URL for token exchange - in dev, derive from request host
    const callbackBase = process.env.APP_URL?.includes('localhost')
      ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}`
      : appUrl;
    const callbackUrl = new URL(`${callbackBase}/api/auth/okta/callback`);
    callbackUrl.searchParams.set('code', code);
    callbackUrl.searchParams.set('state', state);

    // Exchange authorization code for tokens with PKCE verifier
    const { accessToken, tokenResponse } = await exchangeCodeForTokens(config, callbackUrl, codeVerifier, state, idp);

    // Get subject from ID token claims
    const claims = tokenResponse.claims?.();
    const subject = claims?.sub;

    if (!subject) {
      Logger.error('[Okta Callback] No subject in ID token');
      return res.redirect('/login?error=invalid_id_token');
    }

    // Fetch user info from Okta
    const userInfo = await fetchUserInfo(config, accessToken, subject, idp);

    Logger.debug('[Okta Callback] User info received for sub:', userInfo.sub);

    // Find or create user
    const email = userInfo.email;
    const username = userInfo.preferred_username;
    const name = userInfo.name || userInfo.given_name || username || '';

    // For enterprise SSO (Okta), email is required. If Okta doesn't return email,
    // it typically indicates a misconfiguration in the Okta application settings.
    if (!email) {
      Logger.error('[Okta Callback] Missing email in user info - Okta app may be misconfigured');
      await authFailLogRepository.create({
        strategy: 'okta',
        ip,
        userAgent,
        reason: 'Missing email from Okta - check Okta app configuration',
        headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
        meta: { path: req.url, status: 401 },
      });
      return res.redirect('/login?error=email_required');
    }

    // Build query conditions for user lookup (escape regex chars to prevent injection)
    // Email is guaranteed to exist at this point; username is optional
    const conditions: { [field: string]: { $regex: string; $options: string } }[] = [
      { email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' } },
    ];
    if (username) {
      conditions.push({ username: { $regex: `^${escapeRegex(username)}$`, $options: 'i' } });
    }

    let user = await User.findOne({ $or: conditions });

    // Reject system user accounts before touching any data
    if (user) requireNonSystemUser(user);

    // Encrypt tokens if encryption key is available
    const encryptionKey = Config.SECRET_ENCRYPTION_KEY;
    const refreshToken = tokenResponse.refresh_token;

    // Require encryption key in production to prevent storing unencrypted tokens
    const isProduction = !['localhost', '127.0.0.1', '0.0.0.0'].includes(new URL(appUrl).hostname);

    if (!encryptionKey && isProduction) {
      Logger.error(
        '[Okta Callback] SECRET_ENCRYPTION_KEY is required in production. ' +
          'OAuth tokens cannot be stored without encryption.'
      );
      return res.redirect('/login?error=server_configuration_error');
    }

    if (!encryptionKey) {
      Logger.warn(
        '[Okta Callback] SECRET_ENCRYPTION_KEY not configured - OAuth tokens will be stored unencrypted. ' +
          'This is acceptable for local development only.'
      );
    }

    const oauthCredentials = {
      id: userInfo.sub,
      strategy: AuthStrategy.Okta,
      accessToken: encryptionKey ? encryptSecret(accessToken, encryptionKey) : accessToken,
      // Only encrypt refresh token if it exists (avoid encrypting empty strings)
      refreshToken: refreshToken && encryptionKey ? encryptSecret(refreshToken, encryptionKey) : refreshToken || '',
      oktaIdentityProviderId: idp?.id,
      encrypted: !!encryptionKey,
    };

    // Tracks whether this callback links Okta to an existing account for the
    // first time (vs. a routine re-login on an already-linked provider).
    let isNewProviderLink = false;
    if (user) {
      // Update existing user's OAuth credentials
      const authProviders: IAuthProviders[] = user.authProviders || [];
      const existingProviderIndex = authProviders.findIndex(provider => provider.strategy === AuthStrategy.Okta);

      isNewProviderLink = existingProviderIndex === -1;

      // Security gate: auto-linking Okta to an existing local account
      // or replacing the existing Okta entry with a DIFFERENT Okta identity
      // requires BOTH the local user and the Okta userinfo to assert a verified
      // email. Token refresh for the SAME Okta identity is exempt.
      //
      // Identity = (sub, oktaIdentityProviderId). Sub is unique within a tenant
      // but not globally; two configured Okta IdPs could collide on sub. The
      // stored `oktaIdentityProviderId` is the per-IdP discriminator. Sub must
      // be non-empty (defense against legacy rows with falsy id).
      const incomingSub = userInfo.sub;
      const incomingIdpId = idp?.id;
      const existingSameIdentity =
        existingProviderIndex !== -1 &&
        !!incomingSub &&
        authProviders[existingProviderIndex].id === incomingSub &&
        authProviders[existingProviderIndex].oktaIdentityProviderId === incomingIdpId;

      let promoteEmailVerified = false;
      if (!existingSameIdentity) {
        // Shared account-takeover gate (see decideAutoLink) - the SAME decision
        // verifyCallback.ts runs for the passport paths, so the two can't drift.
        // Read `email_verified` straight off the OIDC userinfo as a boolean: the
        // OIDC spec types it as a JSON boolean, so (unlike the passport-shaped
        // profiles) there is no stringly-typed 'true'/'false' to normalise. Do NOT
        // swap in isProviderEmailVerified() here; that helper exists for the wider
        // passport email-array shape this OIDC path never receives.
        const decision = decideAutoLink({
          providerEmailVerified: userInfo.email_verified === true,
          providerEmail: email,
          localEmail: user.email ?? null,
          localEmailVerified: user.emailVerified === true,
          hasUsablePassword: !!user.hasUsablePassword,
        });
        if (decision.action === 'refuse') {
          // decision.detail distinguishes the two verification-required causes
          // (provider- vs local-side) that share one public reason code - keep it
          // in the log for attack forensics.
          Logger.warn(`[Okta Callback] Refusing to auto-link Okta to existing account: ${decision.detail}`, {
            userId: user.id,
            detail: decision.detail,
          });
          await authFailLogRepository.create({
            strategy: 'okta',
            ip,
            userAgent,
            email,
            reason: decision.reason,
            headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
            meta: { path: req.url, status: 401 },
          });
          return res.redirect(`/login?error=${encodeURIComponent(decision.reason)}`);
        }
        promoteEmailVerified = decision.action === 'promote-and-link';
      }

      // Shared account-link write (see applyAccountLink): the tokenVersion bump on
      // a new link and the emailVerified promotion stay in lockstep with the
      // passport paths in verifyCallback.ts. Reflect the persisted fields back onto
      // the in-memory user so the token minted below matches what was written.
      const { update, reflect } = applyAccountLink({
        authProviders,
        oauthCredentials,
        isNewProvider: isNewProviderLink,
        promoteEmailVerified,
        currentTokenVersion: user.tokenVersion,
      });
      await User.updateOne({ _id: user._id }, update);
      Object.assign(user, reflect);
      Logger.debug('[Okta Callback] Updated existing user:', user.id);
    } else {
      // Create new user (no password needed for OAuth users)
      // Email is guaranteed to exist at this point due to validation above
      user = await User.create({
        name,
        username: name,
        email,
        hasUsablePassword: false,
        isAdmin: false,
        oauthCredentials,
        authProviders: [oauthCredentials],
      });
      Logger.debug('[Okta Callback] Created new user:', user.id);
    }

    // Parity with verifyCallback.ts, which omits the password hash from the user
    // it hands downstream. The field is select:false and never loaded on the
    // queries above, so this is purely defensive - it keeps the two auto-link
    // paths consistent and guards against a future query adding +password. Never
    // persisted: nothing below calls user.save() (writes go via User.updateOne).
    user.password = null;

    // Check if user is banned
    if (user.isBanned) {
      throw new ForbiddenError('User is banned');
    }

    // Generate auth tokens
    const tokens = authTokenGenerator.createAccessToken(user.id, user.tokenVersion ?? 0);

    // Log successful OAuth login
    await logEvent({
      userId: user.id,
      type: AuthEvents.LOGIN,
      metadata: {
        strategy: AuthStrategy.Okta,
        ip,
        userAgent,
      },
    });

    await logAuthAudit(req, { userId: user.id, event: 'login_success', strategy: AuthStrategy.Okta });

    // Record the forensic trail for a genuine new account-link (not a re-login),
    // mirroring verifyCallback.ts for the generic OAuth path.
    if (isNewProviderLink) {
      await logAuthAudit(req, { userId: user.id, event: 'oauth_link', strategy: AuthStrategy.Okta });
    }

    Logger.debug('[Okta Callback] Authentication successful for user:', user.id);

    // Resume the originally requested path (round-tripped via the state JWT).
    // /auth/success applies sanitizeRedirectTo before navigating, so it is
    // passed through as an opaque, URL-encoded query value.
    const successQuery = authSuccessRedirectQuery(redirectTo);

    // Redirect to the application with tokens in URL fragment (not query string)
    // Using fragments prevents tokens from being logged in server access logs,
    // sent in Referer headers, or stored in browser history as query params
    const redirectUrl = `/auth/success${successQuery}#token=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&userId=${user.id}`;
    return res.redirect(redirectUrl);
  } catch (error) {
    Logger.error('[Okta Callback] Processing error:', error);
    try {
      await authFailLogRepository.create({
        strategy: 'okta',
        ip,
        userAgent,
        reason: error instanceof Error ? error.message : 'Callback processing error',
        headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
        meta: { path: req.url, status: 500 },
      });
    } catch (logErr) {
      Logger.error('[Okta Callback] Failed to log auth failure:', logErr);
    }
    return res.redirect('/login?error=callback_error');
  }
};

const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(rateLimit({ limit: 20, windowMs: 60 * 1000 })) // 20 requests per minute (callbacks may retry)
  .get(handleOktaCallback);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
