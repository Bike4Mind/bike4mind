import { organizationRepository } from '@bike4mind/database/infra';
import { toSafeOrganizations } from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';

// jwtOnly: powers the signed-in user's own Team page, no API-key use case.
// Kept separate from the membership list: listing a managed team must not add it to the account switcher.
const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const user = req.user!;
  const organizations = await organizationRepository.find({ managerId: user.id });

  return res.json(toSafeOrganizations(organizations, { userId: user.id, isAdmin: user.isAdmin }));
});

export const config = { api: { externalResolver: true } };

export default handler;
