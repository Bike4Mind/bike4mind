import { organizationRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { assertNotOrgServiceAccount } from '@server/auth/assertNotOrgServiceAccount';

/**
 * GET /api/user-api-keys/billing-organizations
 *
 * The organizations the current user may mint org-billed API keys for: those
 * they own or manage (and, for platform admins, this still only lists their own
 * administered orgs - admins mint arbitrary-org keys through the admin surface).
 * Powers the "Bill to" selector in the key-creation UI.
 */
const handler = baseApi({
  requiredScopes: [ApiKeyScope.API_KEYS_MANAGE, ApiKeyScope.ADMIN],
  grandfatherLegacyKeys: true,
}).get(async (req, res) => {
  const userId = req.user?.id;
  assertNotOrgServiceAccount(req.user);

  const administeredOrgIds = await organizationRepository.findIdsAdministeredBy(userId);
  const organizations = await Promise.all(administeredOrgIds.map(id => organizationRepository.findById(id)));

  return res.json(
    organizations
      .filter((org): org is NonNullable<typeof org> => org !== null)
      .map(org => ({ id: org.id, name: org.name }))
  );
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
