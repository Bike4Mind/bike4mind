import { organizationService } from '@bike4mind/services';
import { baseApi } from '@server/middlewares/baseApi';
import { organizationRepository } from '@bike4mind/database/infra';
import { OrganizationEvents, toSafeOrganization } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';

const handler = baseApi().delete(async (req, res) => {
  const organization = await organizationService.revokeAccess(
    req.user,
    { ...(req.query as any) },
    { db: { organizations: organizationRepository } }
  );

  await logEvent(
    {
      userId: req.user.id,
      type: OrganizationEvents.REMOVE_ORG_MEMBER,
      metadata: {
        organizationId: organization.id,
        userId: req.query.userId as string,
      },
    },
    { ability: req.ability }
  );

  return res.json(toSafeOrganization(organization, { userId: req.user.id, isAdmin: req.user.isAdmin }));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
