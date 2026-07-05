import passport from 'passport';
import { authFailLogRepository, identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { setupSamlStrategy } from '@server/auth/auth';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
import { logEvent } from '@server/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { AuthEvents, AuthStrategy } from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';
import { LOG_URL_TRUNCATE_LENGTH } from '@server/auth/oktaConstants';
import { authSuccessRedirectQuery } from '@server/auth/authSuccessRedirect';

const handleSamlCallback = async (req: any, res: any) => {
  try {
    // Extract IDP info from the SAML response/state (simplified; production may want session storage).
    const RelayState = req.method === 'POST' ? req.body?.RelayState : req.query?.RelayState;
    let idpId: string | undefined;
    // Post-login path round-tripped via RelayState; sanitized client-side in
    // /auth/success, so carried through opaquely here.
    let redirectTo: string | undefined;

    console.log('SAML callback received:', {
      method: req.method,
      RelayState,
      body: req.body,
      query: req.query,
    });

    // Try to extract IDP ID from RelayState or other mechanisms
    if (RelayState) {
      const params = new URLSearchParams(RelayState);
      idpId = params.get('idp') || undefined;
      redirectTo = params.get('redirectTo') || undefined;
    }

    if (!idpId) {
      // Fallback: try to get the IDP from query params (for testing)
      idpId = req.query?.idp as string;
      console.log('Fallback - trying IDP from query params:', idpId);
    }

    if (!idpId) {
      // Another fallback: if we only have one SAML IDP, use it
      console.log('No IDP ID found, attempting to find active SAML IDPs...');
      const allIdps = await identityProviderRepository.findAll();
      const samlIdps = allIdps.filter(idp => idp.type === 'saml' && idp.isActive);

      if (samlIdps.length === 1) {
        idpId = samlIdps[0]._id?.toString();
        console.log('Using single active SAML IDP:', idpId);
      } else {
        console.log('Found', samlIdps.length, 'active SAML IDPs, cannot determine which to use');
        return res.redirect('/login?error=missing_idp_context');
      }
    }

    if (!idpId) {
      throw new BadRequestError('Missing IDP context');
    }

    const identityProvider = await identityProviderRepository.findById(idpId);

    if (!identityProvider || !identityProvider.isActive || identityProvider.type !== 'saml') {
      return res.redirect('/login?error=invalid_idp');
    }

    const strategyName = setupSamlStrategy({
      _id: identityProvider.id,
      samlConfig: identityProvider.samlConfig,
    });

    passport.authenticate(strategyName, async (err: Error | null, user: any, info: any) => {
      const ip = req.socket?.remoteAddress || (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const email = (info && (info.email as string)) || undefined;

      if (err) {
        console.error('SAML callback error:', err);
        try {
          await authFailLogRepository.create({
            strategy: 'saml',
            ip,
            userAgent,
            reason: err?.message || 'SAML authenticate error',
            email,
            headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
            meta: { path: req.url, status: 500 },
          });
        } catch (logErr) {
          console.error('Failed to write AuthFailLog (saml err):', logErr);
        }

        // Handle specific signature validation errors
        if (err.message && err.message.includes('signature')) {
          console.error('SAML signature validation failed. Common causes:');
          console.error('1. Certificate format mismatch (check if cert needs BEGIN/END headers)');
          console.error('2. Clock skew between IDP and SP (check time synchronization)');
          console.error('3. Certificate mismatch (verify the correct IDP certificate is configured)');
          console.error('4. Signature algorithm mismatch');
          return res.redirect('/login?error=saml_signature_error');
        }

        return res.redirect('/login?error=saml_auth_error');
      }

      if (!user) {
        console.error('SAML authentication failed:', info);

        try {
          await authFailLogRepository.create({
            strategy: 'saml',
            ip,
            userAgent,
            reason: 'SAML authentication failed',
            email,
            headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
            meta: { path: req.url, status: 401 },
          });
        } catch (logErr) {
          console.debug('Failed to write AuthFailLog (saml no user):', logErr);
        }

        return res.redirect('/login?error=saml_auth_failed');
      }

      if (user.isBanned) {
        throw new ForbiddenError('User is banned');
      }

      const tokens = authTokenGenerator.createAccessToken(user.id, user.tokenVersion ?? 0);

      await logEvent({
        userId: user.id,
        type: AuthEvents.LOGIN,
        metadata: {
          strategy: AuthStrategy.SAML,
          ip: req.ip || req.connection.remoteAddress || (req.headers['x-forwarded-for'] as string) || 'unknown',
          userAgent: req.headers['user-agent'] || 'unknown',
        },
      });

      await logAuthAudit(req, { userId: user.id, event: 'login_success', strategy: AuthStrategy.SAML });

      // Redirect to the application with tokens in URL fragment (not query string)
      // Using fragments prevents tokens from being logged in server access logs,
      // sent in Referer headers, or stored in browser history as query params
      // Derive base URL from request so the redirect goes back to the same port
      const host = req.headers.host || 'localhost:3000';
      const protocol = req.headers['x-forwarded-proto'] || 'http';
      const baseUrl = process.env.APP_URL?.includes('localhost')
        ? `${protocol}://${host}`
        : process.env.APP_URL || `${protocol}://${host}`;
      // Resume the originally requested path (round-tripped via RelayState);
      // /auth/success sanitizes it before navigating.
      const successQuery = authSuccessRedirectQuery(redirectTo);
      const redirectUrl = `${baseUrl}/auth/success${successQuery}#token=${tokens.accessToken}&refreshToken=${tokens.refreshToken}&userId=${user.id}`;

      console.log('Redirecting to:', redirectUrl.substring(0, LOG_URL_TRUNCATE_LENGTH) + '...');
      return res.redirect(redirectUrl);
    })(req, res);
  } catch (error) {
    console.error('SAML callback processing error:', error);
    return res.redirect('/login?error=callback_error');
  }
};

const handler = baseApi({ auth: false }).use(checkBlockedIP()).get(handleSamlCallback).post(handleSamlCallback);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
