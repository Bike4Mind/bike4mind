import passport from 'passport';
import { identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { setupSamlStrategy } from '@server/auth/auth';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { AuthenticateOptions } from '@node-saml/passport-saml/lib/types';
import { issueSamlStateNonce } from '@bike4mind/server-utils/auth/oauthFlowCookie';

const ipGatedApi = baseApi({ auth: false }).use(checkBlockedIP());

const handler = ipGatedApi.get(async (req, res) => {
  const { idp } = req.query;

  if (!idp || typeof idp !== 'string') {
    throw new BadRequestError('IDP parameter is required');
  }

  // Outside the try below: an unknown or non-SAML IdP is caller input, answered 404/400 at warn by
  // the shared error handler rather than logged as a setup failure.
  let identityProvider: Awaited<ReturnType<typeof identityProviderRepository.findByIdWithSecrets>>;
  try {
    identityProvider = await identityProviderRepository.findByIdWithSecrets(idp);
  } catch (error) {
    req.logger.error('SAML identity provider lookup failed', { error });
    return res.redirect('/login?error=saml_setup_failed');
  }

  if (!identityProvider || !identityProvider.isActive) {
    throw new NotFoundError('Identity provider not found or inactive');
  }

  if (identityProvider.type !== 'saml' || !identityProvider.samlConfig) {
    throw new BadRequestError('Invalid SAML configuration');
  }

  try {
    const strategyName = setupSamlStrategy({
      _id: identityProvider.id,
      emailDomain: identityProvider.emailDomain,
      samlConfig: identityProvider.samlConfig,
    });

    // RelayState carries the IDP ID (to identify it in the callback) plus the
    // post-login redirect target, both round-tripped by the IdP. redirectTo is
    // sanitized client-side in /auth/success, so it rides through opaquely.
    // `nh` binds the response to this browser: the callback requires its nonce cookie to hash to it.
    const relayState = new URLSearchParams({ idp: identityProvider.id, nh: issueSamlStateNonce(res) });
    if (typeof req.query.redirectTo === 'string') {
      relayState.set('redirectTo', req.query.redirectTo);
    }

    // RelayState carries a caller-supplied redirectTo and is never logged.

    passport.authenticate(strategyName, <AuthenticateOptions>{
      successRedirect: undefined,
      failureRedirect: '/login?error=saml_auth_failed',
      additionalParams: {
        RelayState: relayState.toString(),
      },
    })(req, res);
  } catch (error) {
    req.logger.error('SAML authentication error', { error });
    return res.redirect('/login?error=saml_setup_failed');
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
