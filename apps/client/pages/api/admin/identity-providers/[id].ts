import { identityProviderRepository, withTransaction, type IIdentityProviderDocument } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { adminApi } from '@server/middlewares/adminApi';
import { BadRequestError, NotFoundError } from '@bike4mind/server-utils/utils/errors';
import { clearConfigurationCache } from '@server/auth/oktaOidcClient';
import { ApiKeyScope, identityProviderResponseSchema, type AuditChange } from '@bike4mind/common';
import { respond } from '@server/utils/respond';
import { recordAdminActionFromRequest } from '@server/utils/adminAudit';

const AUDITED_IDP_FIELDS = ['name', 'emailDomain', 'type', 'isActive'] as const;
const AUDITED_SAML_FIELDS = ['entryPoint', 'issuer', 'callbackUrl', 'identifierFormat'] as const;
const AUDITED_OKTA_FIELDS = ['audience', 'clientId', 'authServerId', 'useOrgAuthServer'] as const;

// Credentials (cert, Okta client secret, SAML key material) are never diffed; callers report them as booleans.
function diffIdentityProvider(existing: IIdentityProviderDocument, updated: IIdentityProviderDocument): AuditChange[] {
  const changes: AuditChange[] = [];
  const push = (field: string, before: unknown, after: unknown) => {
    if (before !== after) changes.push({ field, before, after });
  };
  for (const field of AUDITED_IDP_FIELDS) push(field, existing[field], updated[field]);
  for (const field of AUDITED_SAML_FIELDS) {
    push(`samlConfig.${field}`, existing.samlConfig?.[field], updated.samlConfig?.[field]);
  }
  for (const field of AUDITED_OKTA_FIELDS) {
    push(`oktaConfig.${field}`, existing.oktaConfig?.[field], updated.oktaConfig?.[field]);
  }
  return changes;
}

const handler = adminApi({
  adminPermissions: { GET: 'settings:manage', PUT: 'settings:manage', DELETE: 'settings:manage' },
  requiredScopes: [ApiKeyScope.ADMIN],
})
  .get(async (req, res) => {
    try {
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

      const updatedIdp = await withTransaction(async () => {
        const existing = await identityProviderRepository.findById(id);
        if (!existing) {
          throw new NotFoundError('Identity provider not found');
        }

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
            certReplaced: updated.samlConfig?.cert !== existing.samlConfig?.cert,
            oktaClientSecretReplaced: !!oktaConfig?.clientSecret,
            samlKeyMaterialReplaced: !!(samlConfig?.decryptionPvk || samlConfig?.privateCert),
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
      const { id } = req.query;

      if (!id || typeof id !== 'string') {
        throw new BadRequestError('Identity provider ID is required');
      }

      await withTransaction(async () => {
        const provider = await identityProviderRepository.findById(id);
        if (!provider) {
          throw new NotFoundError('Identity provider not found');
        }

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
