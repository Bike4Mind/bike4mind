import { identityProviderRepository } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, NotFoundError, ForbiddenError } from '@server/utils/errors';
import { clearConfigurationCache } from '@server/auth/oktaOidcClient';

const handler = baseApi()
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

      return res.json(idp);
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

      const updatedIdp = await identityProviderRepository.updateIDP(id, {
        name,
        emailDomain: emailDomain?.toLowerCase(),
        type,
        isActive,
        samlConfig,
        oktaConfig,
      });

      if (!updatedIdp) {
        throw new NotFoundError('Identity provider not found');
      }

      // Clear OIDC configuration cache when Okta config is updated so the next login uses it.
      // Each Lambda instance has its own cache, so propagation may take up to 60s.
      if (oktaConfig !== undefined || type === 'okta') {
        clearConfigurationCache();
        Logger.info('[IDP Admin] Cleared Okta OIDC configuration cache after IDP update');
      }

      return res.json(updatedIdp);
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

      const deleted = await identityProviderRepository.deleteIDP(id);

      if (!deleted) {
        throw new NotFoundError('Identity provider not found');
      }

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
