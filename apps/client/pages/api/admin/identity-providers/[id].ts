import { identityProviderRepository, withTransaction, type IIdentityProviderDocument } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { clearConfigurationCache } from '@server/auth/oktaOidcClient';
import { ApiKeyScope, identityProviderResponseSchema, type AuditChange } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const AUDITED_IDP_FIELDS = ['name', 'emailDomain', 'type', 'isActive'] as const;

// Config blocks hold credentials, so only the non-secret top-level fields are diffed.
function diffIdentityProvider(existing: IIdentityProviderDocument, updated: IIdentityProviderDocument): AuditChange[] {
  return AUDITED_IDP_FIELDS.filter(field => existing[field] !== updated[field]).map(field => ({
    field,
    before: existing[field],
    after: updated[field],
  }));
}

const handler = baseApi({ requiredScopes: [ApiKeyScope.ADMIN] })
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Identity provider ID is required');
      }

      const idp = await identityProviderRepository.findById(id);

      if (!idp) {
        throw new NotFoundError('Identity provider not found');
      }

      return respond(res, identityProviderResponseSchema, idp);
    } catch (error) {
      console.error('Error fetching identity provider:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to fetch identity provider' });
    }
  })
  .put(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Identity provider ID is required');
      }

      const { name, emailDomain, type, isActive, samlConfig, oktaConfig } = req.body;

      // Check if domain change conflicts with existing IDP
      if (emailDomain) {
        const existingIdp = await identityProviderRepository.findByEmailDomain(emailDomain.toLowerCase());
        if (existingIdp && existingIdp.id !== id) {
          throw new BadRequestError('An identity provider already exists for this email domain');
        }
      }

      const existing = await identityProviderRepository.findById(id);
      if (!existing) {
        throw new NotFoundError('Identity provider not found');
      }

      const updatedIdp = await withTransaction(async () => {
        const updated = await identityProviderRepository.updateIDP(id, {
          name,
          emailDomain: emailDomain?.toLowerCase(),
          type,
          isActive,
          samlConfig,
          oktaConfig,
        });

        if (!updated) {
          throw new NotFoundError('Identity provider not found');
        }

        await recordAdminActionFromRequest(req, {
          action: 'identity.sso_provider.updated',
          target: { kind: 'settings', id: updated.id, displayName: updated.name },
          summary: `updated identity provider ${updated.name}`,
          changes: diffIdentityProvider(existing, updated),
          details: {
            samlConfigUpdated: samlConfig !== undefined,
            oktaConfigUpdated: oktaConfig !== undefined,
          },
        });
        return updated;
      });

      // Clear OIDC configuration cache when Okta config is updated so the next login uses it.
      // Each Lambda instance has its own cache, so propagation may take up to 60s.
      if (oktaConfig !== undefined || type === 'okta') {
        clearConfigurationCache();
        Logger.info('[IDP Admin] Cleared Okta OIDC configuration cache after IDP update');
      }

      return respond(res, identityProviderResponseSchema, updatedIdp);
    } catch (error) {
      console.error('Error updating identity provider:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to update identity provider' });
    }
  })
  .delete(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Identity provider ID is required');
      }

      const provider = await identityProviderRepository.findById(id);
      if (!provider) {
        throw new NotFoundError('Identity provider not found');
      }

      await withTransaction(async () => {
        const deleted = await identityProviderRepository.deleteIDP(id);

        if (!deleted) {
          throw new NotFoundError('Identity provider not found');
        }

        await recordAdminActionFromRequest(req, {
          action: 'identity.sso_provider.deleted',
          target: { kind: 'settings', id: provider.id, displayName: provider.name },
          summary: `deleted ${provider.type} identity provider ${provider.name}`,
          details: { emailDomain: provider.emailDomain, type: provider.type },
        });
      });

      // Clear OIDC configuration cache when any IDP is deleted so removed configs don't persist
      clearConfigurationCache();
      Logger.info('[IDP Admin] Cleared Okta OIDC configuration cache after IDP deletion');

      return res.json({ success: true, message: 'Identity provider deleted successfully' });
    } catch (error) {
      console.error('Error deleting identity provider:', error);
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: error.message });
      }
      if (error instanceof BadRequestError) {
        return res.status(400).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Failed to delete identity provider' });
    }
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
