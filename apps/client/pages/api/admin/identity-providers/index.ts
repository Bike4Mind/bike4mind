import { identityProviderRepository, withTransaction } from '@bike4mind/database';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError } from '@bike4mind/server-utils/utils/errors';
import { ApiKeyScope, identityProviderListResponseSchema, identityProviderResponseSchema } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const handler = adminApi({
  adminPermissions: { GET: 'settings:manage', POST: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    try {
      // Presence flags, not values: the UI needs to distinguish a configured credential
      // from a blank one, and the secrets themselves must never reach a response.
      const idps = await identityProviderRepository.findAllWithSecretPresence();
      return respond(res, identityProviderListResponseSchema, idps);
    } catch (error) {
      console.error('Error fetching identity providers:', error);
      return res.status(500).json({ error: 'Failed to fetch identity providers' });
    }
  })
  .post(async (req, res) => {
    try {
      const { name, emailDomain, type, isActive = true, samlConfig, oktaConfig } = req.body;

      if (!name || !emailDomain || !type) {
        throw new BadRequestError('Name, email domain, and type are required');
      }

      if (type === 'saml' && !samlConfig) {
        throw new BadRequestError('SAML configuration is required for SAML type');
      }

      if (type === 'okta' && !oktaConfig) {
        throw new BadRequestError('Okta configuration is required for Okta type');
      }

      // Check if domain already exists
      const existingIdp = await identityProviderRepository.findByEmailDomain(emailDomain.toLowerCase());
      if (existingIdp) {
        throw new BadRequestError('An identity provider already exists for this email domain');
      }

      const newIdp = await withTransaction(async () => {
        const created = await identityProviderRepository.createIDP({
          name,
          emailDomain: emailDomain.toLowerCase(),
          type,
          isActive,
          samlConfig,
          oktaConfig,
          createdBy: req.user!.id,
        });

        await recordAdminActionFromRequest(req, {
          action: 'identity.sso_provider.created',
          target: { kind: 'settings', id: created.id, displayName: created.name },
          summary: `created ${created.type} identity provider ${created.name}`,
          details: {
            name: created.name,
            emailDomain: created.emailDomain,
            type: created.type,
            isActive: created.isActive,
          },
        });
        return created;
      });

      return respond(res, identityProviderResponseSchema, newIdp, 201);
    } catch (error) {
      console.error('Error creating identity provider:', error);
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to create identity provider' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
