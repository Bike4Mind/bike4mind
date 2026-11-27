import passport from 'passport';
import { authFailLogRepository, identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { setupSamlStrategy } from '@server/auth/auth';
import { samlResponseIssuer } from '@server/auth/samlResponseIssuer';
import { issueBrowserSession } from '@server/auth/issueSession';
import { logEvent } from '@bike4mind/server-utils/utils/analyticsLog';
import { logAuthAudit } from '@server/utils/authAudit';
import { AuthEvents, AuthStrategy, clientIdFromAuthorizeRedirect } from '@bike4mind/common';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { LOG_URL_TRUNCATE_LENGTH } from '@server/auth/oktaConstants';
import { authSuccessRedirectQuery, mfaHandoffFragment } from '@server/auth/authSuccessRedirect';
import { resolveSecondFactor } from '@server/auth/signInSecondFactor';
import { isLocalAppUrl } from '@bike4mind/server-utils/utils/validators';
import { stampOAuthSourceTag } from '@server/utils/auth/oauthSourceTag';
import { getClientIp } from '@bike4mind/server-utils/utils/ip';
import type { OAuthUser } from '@server/utils/auth/verifyCallback';
import { emitSignupFunnelEvents, recordSignupAcquisition } from '@server/analytics/funnel';
import { readVisitId } from '@server/analytics/visitSession';
import { recordSignupNetwork } from '@server/auth/networkMeta';
import { refreshSignupRiskScore } from '@server/auth/signupRiskScore';
import { Logger } from '@bike4mind/observability';
import { consumeSamlStateNonce } from '@bike4mind/server-utils/auth/oauthFlowCookie';

const handleSamlCallback = async (req: any, res: any) => {
  try {
    const rawRelayState: unknown = req.method === 'POST' ? req.body?.RelayState : req.query?.RelayState;
    // A repeated parameter arrives as an array, which URLSearchParams below would throw on.
    const RelayState = typeof rawRelayState === 'string' ? rawRelayState : undefined;
    let idpId: string | undefined;
    // Post-login path round-tripped via RelayState; sanitized client-side in
    // /auth/success, so carried through opaquely here.
    let redirectTo: string | undefined;
    let nonceHash: string | undefined;
    const presentedNonceHash = consumeSamlStateNonce(req, res);

    // Never log the request body or RelayState: the body carries the base64
    // SAMLResponse, i.e. a complete signed assertion that is replayable inside its
    // validity window by anyone who can read the logs.
    req.logger.debug('SAML callback received', { method: req.method });

    if (RelayState) {
      const params = new URLSearchParams(RelayState);
      idpId = params.get('idp') || undefined;
      redirectTo = params.get('redirectTo') || undefined;
      nonceHash = params.get('nh') || undefined;
    }

    // RelayState is unsigned, so it only chooses which IdP validates the response: the SAML
    // strategy refuses an assertion whose signed Issuer is not that IdP's. An IdP-initiated
    // login carries no IdP in RelayState and is routed by the Issuer the response names.
    if (!idpId) {
      const issuer = samlResponseIssuer(req.method === 'POST' ? req.body?.SAMLResponse : req.query?.SAMLResponse);
      const matches = issuer ? await identityProviderRepository.findActiveSamlIdpIdsByIssuer(issuer) : [];
      if (matches.length !== 1) {
        req.logger.info('Cannot determine which active SAML IDP to use', { matchingIdps: matches.length });
        return res.redirect('/login?error=missing_idp_context');
      }
      idpId = matches[0];
    }

    const identityProvider = await identityProviderRepository.findByIdWithSecrets(idpId);

    if (!identityProvider || !identityProvider.isActive || identityProvider.type !== 'saml') {
      return res.redirect('/login?error=invalid_idp');
    }

    // Only a response to a login this browser started (index.ts set the nonce cookie that `nh`
    // names) may sign it in. Anything else, an IdP-initiated response included, restarts as a
    // login from this browser; the IdP's own session makes that a silent round trip.
    if (!nonceHash) {
      const restart = new URLSearchParams({ idp: identityProvider.id });
      if (redirectTo) restart.set('redirectTo', redirectTo);
      return res.redirect(`/api/auth/saml?${restart.toString()}`);
    }
    if (presentedNonceHash !== nonceHash) {
      req.logger.warn('SAML response does not belong to a login started in this browser', { idpId });
      return res.redirect('/login?error=saml_session_mismatch');
    }

    const strategyName = setupSamlStrategy({
      _id: identityProvider.id,
      emailDomain: identityProvider.emailDomain,
      samlConfig: identityProvider.samlConfig,
    });

    passport.authenticate(strategyName, async (err: Error | null, user: any, info: any) => {
      const ip = getClientIp(req);
      const userAgent = req.headers['user-agent'] || 'unknown';
      const email = (info && (info.email as string)) || undefined;

      if (err) {
        req.logger.error('SAML callback error', { idpId, strategyName, error: err });
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
          req.logger.error('Failed to write AuthFailLog (saml err)', { idpId, error: logErr });
        }

        // Handle specific signature validation errors
        if (err.message && err.message.includes('signature')) {
          req.logger.error('SAML signature validation failed', {
            idpId,
            strategyName,
            hint: 'check certificate format and match, clock skew between IDP and SP, and signature algorithm',
          });
          return res.redirect('/login?error=saml_signature_error');
        }

        return res.redirect('/login?error=saml_auth_error');
      }

      if (!user) {
        // Both shapes come from our own code, never from the assertion, so either is a
        // safe non-attacker-controlled discriminator: `reason` from the IdP domain bind in
        // auth.ts, `code` from the shared verifyCallback (duplicate key, system user, ...).
        // Reading only `reason` logged those as a generic failure and lost the triage
        // signal the OAuth path records.
        const reason = (info && ((info.reason as string) || (info.code as string))) || 'SAML authentication failed';
        req.logger.error('SAML authentication failed', { idpId, strategyName, reason });

        try {
          await authFailLogRepository.create({
            strategy: 'saml',
            ip,
            userAgent,
            reason,
            email,
            headers: { 'x-forwarded-for': req.headers['x-forwarded-for'] },
            meta: { path: req.url, status: 401 },
          });
        } catch (logErr) {
          req.logger.debug('Failed to write AuthFailLog (saml no user)', { idpId, error: logErr });
        }

        return res.redirect('/login?error=saml_auth_failed');
      }

      if (user.isBanned) {
        throw new ForbiddenError('User is banned');
      }

      // RelayState is not signed, so the client id carries the same trust as the OTC path's
      // client-supplied one: only an active registered client yields a tag.
      if (user.isNewUser) {
        await stampOAuthSourceTag(user.id, clientIdFromAuthorizeRedirect(redirectTo));
        await recordSignupNetwork({ req, userId: user.id, method: AuthStrategy.SAML, clientId: user.signupClientId });
        // After recordSignupNetwork so the datacenter signal sees the stored signup network.
        await refreshSignupRiskScore(user.id, Logger.globalInstance);
        const signupFunnel = await recordSignupAcquisition({ req, user, method: AuthStrategy.SAML });
        await emitSignupFunnelEvents({
          user: { id: user.id, ...signupFunnel },
          method: AuthStrategy.SAML,
          emailVerified: user.emailVerified === true,
          creditsGranted: (user as OAuthUser).signupCreditsGranted ?? 0,
          // Usually absent: the IdP's cross-site POST carries no Lax cookie, so a SAML signup
          // mostly names no visit. Read anyway for the same-site case.
          visitId: readVisitId(req.headers.cookie),
        });
      }

      const secondFactor = await resolveSecondFactor(req, user, {
        origin: { strategy: AuthStrategy.SAML, createdVia: 'saml' },
        enterpriseIdp: true,
      });
      if (secondFactor.kind !== 'satisfied') {
        const handoff = mfaHandoffFragment({
          mfaToken: secondFactor.mfaToken,
          userId: user.id,
          mode: secondFactor.kind === 'enroll' ? 'setup' : 'verify',
          passkeyAvailable: secondFactor.kind === 'challenge' && secondFactor.passkeyAvailable,
        });
        return res.redirect(`/auth/success${authSuccessRedirectQuery(redirectTo)}${handoff}`);
      }

      const { accessToken } = await issueBrowserSession(req, res, user.id, {
        createdVia: 'saml',
        tokenVersion: user.tokenVersion ?? 0,
      });
      const tokens = { accessToken };

      await logEvent({
        userId: user.id,
        type: AuthEvents.LOGIN,
        metadata: {
          strategy: AuthStrategy.SAML,
          ip: getClientIp(req),
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
      const baseUrl = isLocalAppUrl() ? `${protocol}://${host}` : process.env.APP_URL || `${protocol}://${host}`;
      // Resume the originally requested path (round-tripped via RelayState);
      // /auth/success sanitizes it before navigating.
      const successQuery = authSuccessRedirectQuery(redirectTo);
      const signupFragment = user.isNewUser ? '&firstSignupSession=1' : '';
      const redirectUrl = `${baseUrl}/auth/success${successQuery}#token=${tokens.accessToken}&userId=${user.id}${signupFragment}`;

      // The fragment carries the access token, so log only what precedes it.
      req.logger.debug('Redirecting after SAML login', {
        url: redirectUrl.split('#')[0].substring(0, LOG_URL_TRUNCATE_LENGTH),
      });
      return res.redirect(redirectUrl);
    })(req, res);
  } catch (error) {
    req.logger.error('SAML callback processing error', { error });
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
