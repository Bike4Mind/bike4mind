import { organizationRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';

/**
 * GET /api/user-api-keys/billing-organizations
 *
 * The organizations the current user may mint org-billed API keys for: those
 * they own or manage (and, for platform admins, this still only lists their own
 * administered orgs - admins mint arbitrary-org keys through the admin surface).
 * Powers the "Bill to" selector in the key-creation UI.
 */
const handler = baseApi().get(async (req, res) => {
  const userId = req.user?.id;

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
