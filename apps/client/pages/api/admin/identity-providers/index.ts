import { identityProviderRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

const handler = baseApi()
  .get(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

      const idps = await identityProviderRepository.findAll();
      return res.json(idps);
    } catch (error) {
      console.error('Error fetching identity providers:', error);
      return res.status(500).json({ error: 'Failed to fetch identity providers' });
    }
  })
  .post(async (req, res) => {
    try {
      if (!req.user?.isAdmin) {
        throw new ForbiddenError('Unauthorized. Admin access required.');
      }

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

      const newIdp = await identityProviderRepository.createIDP({
        name,
        emailDomain: emailDomain.toLowerCase(),
        type,
        isActive,
        samlConfig,
        oktaConfig,
        createdBy: req.user!.id,
      });

      return res.status(201).json(newIdp);
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
