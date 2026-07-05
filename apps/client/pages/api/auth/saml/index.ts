import passport from 'passport';
import { identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { setupSamlStrategy } from '@server/auth/auth';
import { BadRequestError, NotFoundError } from '@server/utils/errors';
import { AuthenticateOptions } from '@node-saml/passport-saml/lib/types';
import { LOG_URL_TRUNCATE_LENGTH } from '@server/auth/oktaConstants';

const handler = baseApi({ auth: false }).get(async (req, res) => {
  const { idp } = req.query;

  if (!idp || typeof idp !== 'string') {
    throw new BadRequestError('IDP parameter is required');
  }

  try {
    const identityProvider = await identityProviderRepository.findById(idp);

    if (!identityProvider || !identityProvider.isActive) {
      throw new NotFoundError('Identity provider not found or inactive');
    }

    if (identityProvider.type !== 'saml' || !identityProvider.samlConfig) {
      throw new BadRequestError('Invalid SAML configuration');
    }

    const strategyName = setupSamlStrategy({
      _id: identityProvider.id,
      samlConfig: identityProvider.samlConfig,
    });

    // RelayState carries the IDP ID (to identify it in the callback) plus the
    // post-login redirect target, both round-tripped by the IdP. redirectTo is
    // sanitized client-side in /auth/success, so it rides through opaquely.
    const relayState = new URLSearchParams({ idp: identityProvider.id });
    if (typeof req.query.redirectTo === 'string') {
      relayState.set('redirectTo', req.query.redirectTo);
    }

    console.log('Starting SAML authentication for IDP:', identityProvider.id);
    // Truncate: RelayState now carries redirectTo, which can be a long embedded
    // URL (e.g. /oauth/authorize?...). Matches LOG_URL_TRUNCATE_LENGTH usage in
    // the rest of the OAuth/SAML flow.
    console.log('RelayState being set:', relayState.toString().substring(0, LOG_URL_TRUNCATE_LENGTH) + '...');

    passport.authenticate(strategyName, <AuthenticateOptions>{
      successRedirect: undefined,
      failureRedirect: '/login?error=saml_auth_failed',
      additionalParams: {
        RelayState: relayState.toString(),
      },
    })(req, res);
  } catch (error) {
    console.error('SAML authentication error:', error);
    return res.redirect('/login?error=saml_setup_failed');
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
