import { AuthStrategy } from '@bike4mind/common';
import { userRepository, identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { checkBlockedIP } from '@server/middlewares/checkBlockedIP';
import { rateLimit } from '@server/middlewares/rateLimit';

// This endpoint's response necessarily varies by account existence (it routes
// SSO users to their provider), so it can't be made fully enumeration-proof
// without breaking SSO detection. Mitigate abuse with IP blocking and a tight
// per-IP rate limit instead.
const handler = baseApi({ auth: false })
  .use(checkBlockedIP())
  .use(rateLimit({ limit: 10, windowMs: 60 * 1000 }))
  .get(async (req, res) => {
    const { email } = req.query;

    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }

    try {
      const normalizedEmail = email.toLowerCase().trim();
      const emailDomain = normalizedEmail.split('@')[1];

      if (!emailDomain) {
        return res.status(400).json({ error: 'Invalid email format' });
      }

      // Step 1: Check if user exists and what auth methods they have
      const existingUser = await userRepository.findByEmail(normalizedEmail);

      if (existingUser) {
        const { authProviders, password, oauthCredentials } = existingUser;

        const hasSocialOnly = authProviders && authProviders.length > 0 && !password;

        if (hasSocialOnly) {
          const provider = authProviders[0];
          if (provider.strategy === AuthStrategy.Google) {
            return res.json({
              strategy: 'google',
              requiresRedirect: true,
              redirectUrl: `/api/auth/google`,
            });
          }
          if (provider.strategy === AuthStrategy.Github) {
            return res.json({
              strategy: 'github',
              requiresRedirect: true,
              redirectUrl: `/api/auth/github`,
            });
          }
          if (provider.strategy === AuthStrategy.Okta) {
            // Check if there's a database IDP for this user's domain
            const oktaIdp = await identityProviderRepository.findActiveByEmailDomain(emailDomain);
            const hasIdp = oktaIdp && oktaIdp.type === 'okta' && oktaIdp.oktaConfig;
            return res.json({
              strategy: 'okta',
              requiresRedirect: true,
              redirectUrl: hasIdp ? `/api/auth/okta?idp=${oktaIdp!.id}` : `/api/auth/okta`,
              identityProvider: hasIdp ? { id: oktaIdp!.id, name: oktaIdp!.name, type: oktaIdp!.type } : undefined,
            });
          }
        }

        const hasOkta =
          authProviders?.some(provider => provider.strategy === AuthStrategy.Okta) ||
          (oauthCredentials && oauthCredentials.strategy === 'okta');

        if (hasOkta) {
          // Check if there's a database IDP for this user's domain
          const oktaIdp = await identityProviderRepository.findActiveByEmailDomain(emailDomain);
          const hasIdp = oktaIdp && oktaIdp.type === 'okta' && oktaIdp.oktaConfig;
          return res.json({
            strategy: 'okta',
            requiresRedirect: true,
            redirectUrl: hasIdp ? `/api/auth/okta?idp=${oktaIdp!.id}` : `/api/auth/okta`,
            identityProvider: hasIdp ? { id: oktaIdp!.id, name: oktaIdp!.name, type: oktaIdp!.type } : undefined,
          });
        }

        // Check if user has SAML metadata (for future SAML users)
        const hasSaml = authProviders?.some(provider => provider.strategy === AuthStrategy.SAML);

        if (hasSaml) {
          const idp = await identityProviderRepository.findActiveByEmailDomain(emailDomain);
          if (idp) {
            return res.json({
              strategy: 'saml',
              requiresRedirect: true,
              redirectUrl: `/api/auth/saml?idp=${idp.id}`,
              identityProvider: {
                id: idp.id,
                name: idp.name,
                type: idp.type,
              },
            });
          }
        }

        // Default: use OTC (passwordless) flow
        return res.json({
          strategy: 'otc',
          requiresRedirect: false,
        });
      }

      // Step 2: No existing user - check domain-based SAML IDPs
      const idp = await identityProviderRepository.findActiveByEmailDomain(emailDomain);

      if (idp) {
        if (idp.type === 'saml') {
          return res.json({
            strategy: 'saml',
            requiresRedirect: true,
            redirectUrl: `/api/auth/saml?idp=${idp.id}`,
            identityProvider: {
              id: idp.id,
              name: idp.name,
              type: idp.type,
            },
          });
        }

        if (idp.type === 'okta' && idp.oktaConfig) {
          return res.json({
            strategy: 'okta',
            requiresRedirect: true,
            redirectUrl: `/api/auth/okta?idp=${idp.id}`,
            identityProvider: {
              id: idp.id,
              name: idp.name,
              type: idp.type,
            },
          });
        }
      }

      // Step 3: No user, no IDP match - default to OTC (passwordless) strategy
      return res.json({
        strategy: 'otc',
        requiresRedirect: false,
      });
    } catch (error) {
      console.error('Auth strategy lookup error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
