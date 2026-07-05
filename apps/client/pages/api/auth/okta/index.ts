/**
 * Okta OAuth Authentication Entry Point
 *
 * Initiates Okta OAuth authentication using OpenID Connect with proper PKCE support.
 *
 * Usage:
 *   GET /api/auth/okta?idp=<idp-id>     - Use database IDP config
 *   GET /api/auth/okta                   - Use SST secrets fallback
 *
 * Security features:
 * - PKCE (Proof Key for Code Exchange) per RFC 7636/9700
 * - JWT-based state tokens for serverless environments
 * - IDP ID embedded in state for callback routing
 *
 * @see https://datatracker.ietf.org/doc/rfc7636/
 */
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { getOktaConfigWithFallback, generatePkceParams, buildAuthorizationUrl } from '@server/auth/oktaOidcClient';
import { createStateToken } from '@server/auth/jwtStateStore';
import { OKTA_STATE_AUDIENCE, LOG_URL_TRUNCATE_LENGTH, OktaStateInput } from '@server/auth/oktaConstants';
import { NotFoundError } from '@server/utils/errors';
import { validateAppUrl } from '@server/utils/validators';
import { Logger } from '@bike4mind/observability';

const handler = baseApi({ auth: false })
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000 })) // 10 requests per minute
  .get(async (req, res) => {
    // Coerce to string-or-undefined: `?idp=a&idp=b` yields an array, which would
    // otherwise flow into the config lookup. An array (or absent) value falls
    // back to the SST-configured Okta - the same path as no `idp` at all.
    const idpParam = req.query.idp;
    const idpId = typeof idpParam === 'string' ? idpParam : undefined;

    try {
      // Validate APP_URL before proceeding
      const appUrl = validateAppUrl('Okta Auth');
      if (!appUrl) {
        Logger.error('[Okta Auth] APP_URL environment variable is missing or invalid');
        return res.redirect('/login?error=server_configuration_error');
      }

      // Resolve Okta config (database first, SST fallback)
      const { config, source, idp } = await getOktaConfigWithFallback(idpId);

      if (!config) {
        Logger.warn('[Okta Auth] No Okta configuration available');
        return res.redirect('/login?error=okta_not_configured');
      }

      // If idpId was provided but not found in database, still allow SST fallback
      if (idpId && !idp && source === 'sst') {
        Logger.debug('[Okta Auth] IDP not found in database, using SST fallback');
      }

      // Validate IDP is active if using database config
      if (idp && !idp.isActive) {
        throw new NotFoundError('Identity provider is inactive');
      }

      // Generate PKCE parameters
      const pkceParams = await generatePkceParams();

      // Create state token with IDP ID, PKCE verifier, and the post-login
      // redirect target (round-tripped via the IdP, restored in the callback).
      const statePayload: OktaStateInput = {
        idpId: idp?.id || undefined,
        codeVerifier: pkceParams.codeVerifier,
        redirectTo: typeof req.query.redirectTo === 'string' ? req.query.redirectTo : undefined,
      };

      const stateToken = createStateToken<OktaStateInput>({ audience: OKTA_STATE_AUDIENCE }, statePayload);

      // Build callback URL - in dev, derive from request host so OAuth
      // redirects back to the correct port (Next.js may not be on :3000)
      const callbackUrl = process.env.APP_URL?.includes('localhost')
        ? `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || 'localhost:3000'}/api/auth/okta/callback`
        : `${appUrl}/api/auth/okta/callback`;

      // Build authorization URL with PKCE
      const authUrl = await buildAuthorizationUrl(config, callbackUrl, pkceParams, stateToken, undefined, idp);

      Logger.debug('[Okta Auth] Starting authentication', {
        source,
        idpId: idp?.id || 'sst-fallback',
        hasPkce: true,
        authUrl: authUrl.toString().substring(0, LOG_URL_TRUNCATE_LENGTH) + '...',
      });

      // Redirect to Okta authorization endpoint
      return res.redirect(authUrl.toString());
    } catch (error) {
      Logger.error('[Okta Auth] Setup error:', error);
      return res.redirect('/login?error=okta_setup_failed');
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
